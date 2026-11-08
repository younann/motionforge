import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
test('plugin manifest and marketplace reference root',async()=>{
 const plugin=JSON.parse(await readFile(join(root,'.claude-plugin/plugin.json')));
 const marketplace=JSON.parse(await readFile(join(root,'.claude-plugin/marketplace.json')));
 assert.equal(plugin.name,'motionforge');assert.equal(marketplace.plugins[0].source,'./');
 const skill=await readFile(join(root,'skills/open/SKILL.md'),'utf8');assert.match(skill,/launch\.mjs/);
});
