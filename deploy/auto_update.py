#!/usr/bin/env python3
"""Poll one public GitHub workflow; deploy verified GHCR images with rollback.
No repository token or server SSH key is sent to GitHub. Python standard library only.
"""
import argparse
import concurrent.futures
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

REPO = 'magiczheng/werewolf'
WORKFLOW = 'docker.yml'
SHA = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
ACCEPT = ', '.join(['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
                    'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'])


def log(event, **fields):
    print(json.dumps({'event': event, **fields}, ensure_ascii=False), flush=True)


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def atomic_write(path, content):
    path = Path(path)
    temporary = path.with_name(path.name + '.new')
    temporary.write_text(content)
    temporary.chmod(0o600)
    os.replace(temporary, path)


def request(url, headers=None, timeout=45):
    req = urllib.request.Request(url, headers={'User-Agent': 'werewolf-deployer/1', **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def candidate(run, state):
    """Do not deploy PRs, tags, pending/failed builds, old runs or a blocked release."""
    if run.get('head_branch') != 'main' or run.get('event') != 'push':
        return None
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        return None
    if run.get('path') != '.github/workflows/' + WORKFLOW:
        return None
    sha = run.get('head_sha', '')
    if not SHA.fullmatch(sha):
        raise ValueError('Invalid commit SHA')
    if sha == state.get('revision') or int(run['run_number']) < state.get('run_number', 0):
        return None
    key = f"{int(run['id'])}:{int(run.get('run_attempt', 1))}"
    if state.get('blocked_release') == key:
        return None
    return {'revision': sha, 'key': key, 'run_number': int(run['run_number']), 'url': run['html_url']}


class Registry:
    def __init__(self, cache):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        with request('https://ghcr.io/token?' + urllib.parse.urlencode({'scope': f'repository:{REPO}:pull'})) as response:
            self.token = json.load(response)['token']
        self.base = f'https://ghcr.io/v2/{REPO}'

    def get(self, path, extra=None):
        with request(self.base + path, {'Authorization': 'Bearer ' + self.token, 'Accept': ACCEPT, **(extra or {})}, 90) as response:
            return response.read()

    def manifest(self, revision):
        raw = self.get('/manifests/sha-' + revision)
        manifest = json.loads(raw)
        if 'manifests' in manifest:
            platform = next(m for m in manifest['manifests'] if m.get('platform', {}).get('os') == 'linux'
                            and m.get('platform', {}).get('architecture') == 'amd64')
            if not DIGEST.fullmatch(platform['digest']):
                raise ValueError('Invalid manifest digest')
            raw = self.get('/manifests/' + platform['digest'])
            if digest(raw) != platform['digest']:
                raise ValueError('Manifest digest mismatch')
            manifest = json.loads(raw)
        for descriptor in [manifest['config']] + manifest['layers']:
            if not DIGEST.fullmatch(descriptor['digest']) or not isinstance(descriptor['size'], int) or descriptor['size'] <= 0:
                raise ValueError('Invalid blob descriptor')
        return manifest, digest(raw)

    def blob(self, descriptor):
        expected, size = descriptor['digest'], descriptor['size']
        path = self.cache / (expected[7:] + '.blob')
        if path.exists() and path.stat().st_size == size and digest(path.read_bytes()) == expected:
            return path
        part_size = 2 * 1024 * 1024

        def segment(start):
            end = min(size - 1, start + part_size - 1)
            part = path.with_name(path.name + '.part' + str(start))
            # Partial files are only persisted after the entire HTTP range is received.
            if part.exists() and part.stat().st_size == end - start + 1:
                return part.read_bytes()
            for attempt in range(3):
                try:
                    if size <= part_size:
                        data = self.get('/blobs/' + expected)
                    else:
                        url = self.base + '/blobs/' + expected + '?segment=' + str(start)
                        with request(url, {'Authorization': 'Bearer ' + self.token, 'Range': f'bytes={start}-{end}'}, 90) as response:
                            if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                                raise ValueError('Registry did not honor requested range')
                            data = response.read()
                    if len(data) != end - start + 1:
                        raise ValueError('Incomplete registry range')
                    part.write_bytes(data)
                    return data
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(2 ** attempt)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            data = b''.join(pool.map(segment, range(0, size, part_size)))
        if digest(data) != expected:
            for part in self.cache.glob(path.name + '.part*'):
                part.unlink()
            raise ValueError('Blob checksum mismatch')
        temporary = path.with_name(path.name + '.new')
        temporary.write_bytes(data)
        os.replace(temporary, path)
        for part in self.cache.glob(path.name + '.part*'):
            part.unlink()
        log('blob_verified', digest=expected, bytes=size)
        return path

    def archive(self, revision, work):
        manifest, manifest_digest = self.manifest(revision)
        config_path = self.blob(manifest['config'])
        config = json.loads(config_path.read_bytes())
        labels = config.get('config', {}).get('Labels', {})
        version = labels.get('org.opencontainers.image.version', '')
        if labels.get('org.opencontainers.image.revision') != revision or not VERSION.fullmatch(version):
            raise ValueError('Image revision/version does not match the successful CI run')
        if config.get('architecture') != 'amd64' or config.get('os') != 'linux':
            raise ValueError('Unexpected image platform')
        diff_ids = config.get('rootfs', {}).get('diff_ids', [])
        if len(diff_ids) != len(manifest['layers']):
            raise ValueError('Invalid rootfs metadata')
        paths = [self.blob(layer) for layer in manifest['layers']]
        image = f'ghcr.io/{REPO}:sha-{revision}'
        target = Path(work) / 'image.tar'
        layers = []
        with tarfile.open(target, 'w') as tar:
            config_name = manifest['config']['digest'][7:] + '.json'
            tar.add(config_path, arcname=config_name)
            for descriptor, blob, diff_id in zip(manifest['layers'], paths, diff_ids):
                raw_path = Path(work) / (descriptor['digest'][7:] + '.tar')
                # OCI gzip layers are downloaded as blobs; never extract their paths on the host.
                with blob.open('rb') as probe:
                    compressed = probe.read(2) == b'\x1f\x8b'
                opener = gzip.open if compressed else open
                hasher = hashlib.sha256()
                with opener(blob, 'rb') as src, raw_path.open('wb') as dst:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        hasher.update(chunk)
                        dst.write(chunk)
                if 'sha256:' + hasher.hexdigest() != diff_id:
                    raise ValueError('Uncompressed layer checksum mismatch')
                name = descriptor['digest'][7:] + '/layer.tar'
                layers.append(name)
                tar.add(raw_path, arcname=name)
            payload = json.dumps([{'Config': config_name, 'RepoTags': [image], 'Layers': layers}]).encode()
            info = tarfile.TarInfo('manifest.json')
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
        blobs = [d['digest'][7:] for d in [manifest['config']] + manifest['layers']]
        return {'image': image, 'version': version, 'image_id': manifest['config']['digest'],
                'manifest': manifest_digest, 'blobs': blobs, 'archive': str(target)}


class Deployer:
    def __init__(self, root):
        self.root = Path(root)
        self.state_path = self.root / 'deploy-state.json'
        self.cache = self.root / 'deploy-cache'
        self.cache.mkdir(parents=True, exist_ok=True)

    def command(self, args, timeout=180):
        result = subprocess.run(args, cwd=self.root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f'{args[0]} command failed: {result.stdout[-1500:]}')
        return result.stdout.strip()

    def read_state(self):
        return json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def save_state(self, state):
        atomic_write(self.state_path, json.dumps(state, indent=2) + '\n')

    def check_health(self, revision=None):
        with request('http://127.0.0.1:3000/api/health', timeout=10) as response:
            if json.load(response).get('ok') is not True:
                raise ValueError('Database health check failed')
        if revision:
            with request('http://127.0.0.1:3000/api/version', timeout=10) as response:
                if json.load(response).get('revision') != revision:
                    raise ValueError('Running revision does not match deployment')

    def backup(self, release):
        directory = self.root / 'data' / 'backups'
        directory.mkdir(mode=0o750, exist_ok=True)
        os.chown(directory, 1000, 1000)
        filename = f"before-{release['revision'][:12]}-{int(time.time())}.sqlite"
        code = "import Database from 'better-sqlite3'; const db=new Database(process.env.DB_PATH,{readonly:true,fileMustExist:true}); await db.backup(process.argv[1]); db.close();"
        self.command(['docker', 'compose', 'exec', '-T', 'werewolf', 'node', '--input-type=module', '-e', code, '--', '/app/data/backups/' + filename])
        log('database_backed_up', file=filename)

    def activate(self, release, image):
        state = self.read_state()
        env_path = self.root / '.env'
        previous_env = env_path.read_text()
        if not re.search(r'^APP_IMAGE=.+$', previous_env, re.M):
            raise ValueError('APP_IMAGE missing from .env')
        previous_image = re.search(r'^APP_IMAGE=(.+)$', previous_env, re.M)[1]
        self.backup(release)  # Abort without touching the running app if backup fails.
        new_env = re.sub(r'^APP_IMAGE=.*$', lambda _: 'APP_IMAGE=' + image['image'], previous_env, flags=re.M)
        atomic_write(env_path, new_env)
        try:
            self.command(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '90'], timeout=120)
            self.check_health(release['revision'])
        except Exception as error:
            atomic_write(env_path, previous_env)
            state['blocked_release'] = release['key']
            state['last_failure'] = str(error)
            self.save_state(state)
            try:
                self.command(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '90'], timeout=120)
                self.check_health()
            except Exception:
                log('rollback_failed', release=release['key'])
                raise
            log('deployment_rolled_back', release=release['key'], previous_image=previous_image)
            raise
        self.save_state({**release, 'image': image['image'], 'version': image['version'], 'image_id': image['image_id'],
                         'manifest': image['manifest'], 'deployed_at': datetime.now(timezone.utc).isoformat(),
                         'previous_image': previous_image, 'blobs': image['blobs'], 'previous_blobs': state.get('blobs', [])})
        # Only prune this updater's old blob cache. Never prune unrelated Docker images or backups.
        keep = set(image['blobs'] + state.get('blobs', []))
        for blob in self.cache.glob('*.blob'):
            if blob.stem not in keep:
                blob.unlink()
        log('deployment_succeeded', version=image['version'], revision=release['revision'])

    def run(self, dry_run=False):
        with request(f'https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/runs?branch=main&event=push&per_page=1',
                     {'Accept': 'application/vnd.github+json'}) as response:
            runs = json.load(response)['workflow_runs']
        release = candidate(runs[0], self.read_state()) if runs else None
        if not release:
            log('no_update')
            return
        log('release_available', **release)
        if dry_run:
            return
        registry = Registry(self.cache)
        with tempfile.TemporaryDirectory(prefix='import-', dir=self.cache) as work:
            image = registry.archive(release['revision'], work)
            self.command(['docker', 'load', '--input', image['archive']], timeout=180)
            loaded_id = self.command(['docker', 'image', 'inspect', image['image'], '--format', '{{.Id}}'])
            if loaded_id != image['image_id']:
                raise ValueError('Loaded image ID does not match verified configuration')
            self.activate(release, image)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/opt/werewolf')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    deployer = Deployer(args.root)
    with (deployer.root / 'deploy.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log('already_running')
            return
        try:
            deployer.run(args.dry_run)
        except Exception as error:
            log('update_failed', error=str(error))
            raise SystemExit(1)


if __name__ == '__main__':
    main()
