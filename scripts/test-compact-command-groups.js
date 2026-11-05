/** Read-only check: build each compact command's Discord registration payload. */
import assert from 'node:assert/strict';

const groups = [
  ['tools', 11, '../src/commands/Tools/tools.js'],
  ['fun', 3, '../src/commands/Fun/fun.js'],
  ['utility', 5, '../src/commands/Utility/utility.js'],
];

for (const [expectedName, expectedCount, path] of groups) {
  const { default: command } = await import(path);
  const json = command.data.toJSON();
  assert.equal(json.name, expectedName);
  assert.equal(json.type, 1);
  assert.equal(json.options.length, expectedCount);
  assert.ok(command.slashOnly);
  const seen = new Set();
  for (const option of json.options) {
    assert.equal(option.type, 1, `/${expectedName} child must be a subcommand`);
    assert.ok(option.name.length >= 1 && option.name.length <= 32);
    assert.ok(option.description.length >= 1 && option.description.length <= 100);
    assert.ok(!seen.has(option.name), `Duplicate subcommand ${option.name}`);
    seen.add(option.name);
    assert.ok((option.options?.length || 0) <= 25);
    assert.ok(!(option.options || []).some(child => child.type === 1 || child.type === 2));
  }
  console.log(`PASS: /${expectedName} has ${expectedCount} valid subcommands`);
}
console.log('No Discord requests were sent. Test is read-only.');
