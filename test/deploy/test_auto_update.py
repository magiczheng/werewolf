import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('auto_update', Path(__file__).parents[2] / 'deploy/auto_update.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = 'a' * 40
OLD = 'b' * 40


def run(**extra):
    return {'id': 123, 'run_number': 7, 'run_attempt': 1, 'head_sha': SHA, 'head_branch': 'main',
            'event': 'push', 'status': 'completed', 'conclusion': 'success',
            'path': '.github/workflows/docker.yml', 'html_url': 'https://github.com/run/123', **extra}


class CandidateTests(unittest.TestCase):
    def test_only_successful_main_workflow_is_eligible(self):
        self.assertEqual(m.candidate(run(), {})['revision'], SHA)
        for change in [{'conclusion': 'failure'}, {'status': 'in_progress'}, {'event': 'pull_request'},
                       {'event': 'workflow_dispatch'}, {'head_branch': 'other'}, {'path': '.github/workflows/other.yml'}]:
            self.assertIsNone(m.candidate(run(**change), {}))

    def test_current_old_and_blocked_releases_are_not_redeployed(self):
        for state in [{'revision': SHA}, {'run_number': 8}, {'blocked_release': '123:1'}]:
            self.assertIsNone(m.candidate(run(), state))
        self.assertIsNotNone(m.candidate(run(run_attempt=2), {'blocked_release': '123:1'}))

    def test_bad_sha_is_rejected(self):
        with self.assertRaises(ValueError):
            m.candidate(run(head_sha='../../bad'), {})


class RegistryTests(unittest.TestCase):
    def test_cached_blob_is_verified_and_corruption_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = m.Registry.__new__(m.Registry)
            registry.cache = Path(directory)
            data = b'verified layer'
            descriptor = {'digest': m.digest(data), 'size': len(data)}
            registry.get = Mock(return_value=data)
            result = registry.blob(descriptor)
            self.assertEqual(result.read_bytes(), data)
            registry.get.reset_mock()
            registry.blob(descriptor)
            registry.get.assert_not_called()
            result.write_bytes(b'bad')
            registry.blob(descriptor)
            registry.get.assert_called_once()

    def test_wrong_blob_digest_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = m.Registry.__new__(m.Registry)
            registry.cache = Path(directory)
            registry.get = Mock(return_value=b'bad')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                registry.blob({'digest': m.digest(b'yes'), 'size': 3})
            self.assertEqual(list(Path(directory).glob('*.blob')), [])

    def test_archive_checks_revision_and_uncompressed_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = m.Registry.__new__(m.Registry)
            registry.cache = Path(directory)
            data = b'tar content for a layer'
            config = {'architecture': 'amd64', 'os': 'linux', 'rootfs': {'diff_ids': [m.digest(data)]},
                      'config': {'Labels': {'org.opencontainers.image.revision': SHA, 'org.opencontainers.image.version': '1.1.0'}}}
            config_data = json.dumps(config).encode()
            layer_data = gzip.compress(data)
            manifest = {'config': {'digest': m.digest(config_data), 'size': len(config_data)},
                        'layers': [{'digest': m.digest(layer_data), 'size': len(layer_data)}]}
            files = {}
            for content in [config_data, layer_data]:
                file = Path(directory) / m.digest(content)[7:]
                file.write_bytes(content)
                files[m.digest(content)] = file
            registry.manifest = Mock(return_value=(manifest, 'sha256:' + 'c' * 64))
            registry.blob = lambda descriptor: files[descriptor['digest']]
            with tempfile.TemporaryDirectory() as work:
                result = registry.archive(SHA, work)
                with tarfile.open(result['archive']) as archive:
                    entry = json.load(archive.extractfile('manifest.json'))[0]
                    self.assertEqual(entry['RepoTags'], ['ghcr.io/magiczheng/werewolf:sha-' + SHA])
                    self.assertEqual(archive.extractfile(entry['Layers'][0]).read(), data)
                with self.assertRaisesRegex(ValueError, 'revision/version'):
                    registry.archive(OLD, work)
                config['rootfs']['diff_ids'] = [m.digest(b'wrong')]
                files[manifest['config']['digest']].write_text(json.dumps(config))
                with self.assertRaisesRegex(ValueError, 'Uncompressed'):
                    registry.archive(SHA, work)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.old_env = 'APP_IMAGE=old-image\nTRUSTED_PROXIES=172.19.0.1\n'
        (self.root / '.env').write_text(self.old_env)
        self.deployer = m.Deployer(self.root)
        self.deployer.backup = Mock()
        self.deployer.command = Mock(return_value='')
        self.deployer.check_health = Mock()
        self.deployer.save_state({'revision': OLD, 'run_number': 6})
        self.release = m.candidate(run(), {})
        self.image = {'image': 'new-image', 'version': '1.1.0', 'image_id': 'sha256:id', 'manifest': 'sha256:manifest', 'blobs': []}

    def test_success_writes_version_and_preserves_other_env(self):
        self.deployer.activate(self.release, self.image)
        self.assertEqual((self.root / '.env').read_text(), 'APP_IMAGE=new-image\nTRUSTED_PROXIES=172.19.0.1\n')
        state = self.deployer.read_state()
        self.assertEqual(state['version'], '1.1.0')
        self.assertEqual(state['revision'], SHA)
        self.assertEqual(state['previous_image'], 'old-image')
        self.deployer.backup.assert_called_once()
        self.deployer.check_health.assert_called_once_with(SHA)

    def test_backup_failure_never_changes_running_app(self):
        self.deployer.backup.side_effect = RuntimeError('backup failed')
        with self.assertRaises(RuntimeError):
            self.deployer.activate(self.release, self.image)
        self.assertEqual((self.root / '.env').read_text(), self.old_env)
        self.deployer.command.assert_not_called()

    def test_wrong_running_revision_rolls_back_and_blocks_retry(self):
        self.deployer.check_health.side_effect = [ValueError('wrong revision'), None]
        with self.assertRaises(ValueError):
            self.deployer.activate(self.release, self.image)
        self.assertEqual((self.root / '.env').read_text(), self.old_env)
        self.assertEqual(self.deployer.command.call_count, 2)
        state = self.deployer.read_state()
        self.assertEqual(state['revision'], OLD)
        self.assertEqual(state['blocked_release'], '123:1')
        self.assertIsNone(m.candidate(run(), state))

    def test_compose_failure_rolls_back(self):
        self.deployer.command.side_effect = [RuntimeError('bad image'), 'healthy']
        with self.assertRaises(RuntimeError):
            self.deployer.activate(self.release, self.image)
        self.assertEqual((self.root / '.env').read_text(), self.old_env)
        self.deployer.check_health.assert_called_once_with()

    def test_failed_rollback_remains_visible(self):
        self.deployer.command.side_effect = RuntimeError('compose failed')
        with self.assertRaises(RuntimeError):
            self.deployer.activate(self.release, self.image)
        self.assertEqual(self.deployer.read_state()['blocked_release'], '123:1')
        self.assertEqual((self.root / '.env').read_text(), self.old_env)


if __name__ == '__main__':
    unittest.main()
