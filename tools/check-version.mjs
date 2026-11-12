import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '使用 major.minor.patch 格式');
assert.equal(pkg.version, lock.version, 'package-lock.json 版本不一致');
assert.equal(pkg.version, lock.packages[''].version, '锁文件根包版本不一致');
if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
  assert.equal(process.env.GITHUB_REF, `refs/tags/v${pkg.version}`, '发布 tag 必须与 package.json 版本一致');
}
console.log(`Version v${pkg.version} verified`);
