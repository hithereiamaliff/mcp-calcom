import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The VPS also runs Cal.diy from /opt/calcom. Compose names a project after its folder, so
// without an explicit name both stacks were "calcom", and the first deploy's orphan removal
// deleted Cal.diy's containers.
describe('deployment', () => {
  it('uses its own Compose project name', () => {
    assert.match(readFileSync('docker-compose.yml', 'utf8'), /^name: mcp-calcom$/m);
  });

  it('never removes orphan containers in the deploy', () => {
    const commands = readFileSync('.github/workflows/deploy-vps.yml', 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('#'));
    assert.equal(commands.some(line => line.includes('--remove-orphans')), false);
  });
});
