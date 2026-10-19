import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNotionPageLink} from './notionPageLink.js';
const id='a1b2c3d4e5f6478890abcdef123456789',uuid='a1b2c3d4-e5f6-4788-90ab-cdef123456789';
// Use a canonical 32-character page identifier, independent of account data.
const page='a1b2c3d4e5f6478890abcdef1234567890',hyphen='a1b2c3d4-e5f6-4788-90ab-cdef1234567890';
test('Notion links accept shared/desktop/new-domain formats, titles, trailing slashes, query parameters and wrappers',()=>{
  const canonical='123456781234123412341234567890ab';
  const dashed='12345678-1234-1234-1234-1234567890ab';
  for(const input of [canonical,dashed,`https://www.notion.so/ONE-${canonical}?pvs=4`,`https://notion.so/workspace/${dashed}/?source=copy_link#${page}`,`https://team.notion.site/ONE-${canonical}/`,`https://app.notion.com/workspace/${canonical}`,`https://www.notion.com/ONE-${canonical}`,`notion://www.notion.so/ONE-${canonical}?source=copy_link`,`[我的页面](https://www.notion.so/ONE-${canonical})`,`<https://www.notion.so/${canonical}>`,`  https://notion.so/${canonical.toUpperCase()}  `])assert.equal(parseNotionPageLink(input).pageId,canonical,input);
  assert.equal(parseNotionPageLink(`https://www.notion.so/${canonical}?v=${id}&p=${dashed}`).pageId,canonical);
});
test('view/block IDs and unrelated URLs never become destinations; invalid input has a next step',()=>{
  for(const input of [null,'','self','notion://docs/spec',`http://notion.so/${page}`,`https://notion.so.evil.example/${page}`,`https://evil.example/${page}`,`https://evil-notion.so/${page}`,`https://user:pass@notion.so/${page}`,`https://notion.so:8443/${page}`,`https://www.notion.so/?v=${page}#${page}`,`https://team.notion.site/my-pretty-slug`,`https://notion.so/${'a'.repeat(33)}`,`https://notion.so/%ZZ`,uuid,hyphen,'x'.repeat(4097)]){
    const parsed=parseNotionPageLink(input);assert.equal(parsed.pageId,undefined,String(input));assert.ok(parsed.error);assert.match(parsed.error,/复制链接/);
  }
  assert.match(parseNotionPageLink(`https://notion.so/${id}?p=invalid`).error!,/页面编号不完整/);
});
