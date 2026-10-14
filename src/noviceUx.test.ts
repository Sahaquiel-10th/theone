import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { products, trialCatalog } from '../server/memberships';
import { featureMention, withoutFeatureMention, monthlyAllowanceComparison, purchaseAction, purchaseTiming, transferStateLabel } from './noviceUx';
const plans=products(trialCatalog),standard=plans.find(p=>p.id==='standard-monthly')!,premium=plans.find(p=>p.id==='premium-monthly')!;

test('purchase action distinguishes opening, renewal, upgrade and queued lower tier',()=>{
  assert.equal(purchaseAction(standard),'开通会员');
  assert.equal(purchaseAction(standard,'standard'),'续费');
  assert.equal(purchaseAction(premium,'standard'),'升级高级会员');
  assert.equal(purchaseAction(standard,'premium'),'预约普通会员');
  assert.match(purchaseTiming(standard,'premium'),/已有会员之后/);
  assert.match(purchaseTiming(premium,'standard'),/剩余时间顺延/);
  assert.equal(purchaseAction(plans.find(p=>p.kind==='key')!),'购买启动器套餐');
});
test('plan comparison derives from the current published quantities, not hardcoded 3.5',()=>{
  assert.equal(monthlyAllowanceComparison(premium,plans),'3.5 倍普通会员月额度');
  assert.equal(monthlyAllowanceComparison({...premium,monthlyMicros:80e6},plans),'4 倍普通会员月额度');
  assert.equal(monthlyAllowanceComparison(standard,plans),'标准月额度');
});
test('feature mentions handle Chinese, caret location and email addresses without stealing normal input',()=>{
  assert.deepEqual(featureMention('请用 @周报'),{start:3,end:6,query:'周报'});
  assert.equal(featureMention('a@example.com'),null);
  assert.equal(featureMention('请用 @周报\n继续'),null);
  assert.equal(featureMention('@'+'a'.repeat(51)),null);
  assert.deepEqual(featureMention('请用 @周报 后续要求',6),{start:3,end:6,query:'周报'});
});
test('selecting a feature removes only its mention, retains the original request and never overwrites a newer draft',()=>{
  const text='请用 @周报 整理本周工作',mention=featureMention(text,6);
  assert.equal(withoutFeatureMention(text,mention),'请用  整理本周工作');
  assert.equal(withoutFeatureMention('换成新内容再做',mention),'换成新内容再做');
  assert.equal(withoutFeatureMention('请用 @办公 整理本周工作',mention),'请用 @办公 整理本周工作');
});
test('execution labels preserve queued, unknown, failed and cancelled meanings',()=>{
  assert.match(transferStateLabel('queued'),/等开始/);
  assert.match(transferStateLabel('failed'),/没做成/);
  assert.match(transferStateLabel('interrupted'),/还要核对/);
  assert.match(transferStateLabel('cancelled'),/不会自动再跑/);
  assert.match(transferStateLabel('selecting_target'),/选一个工作文件夹/);
  assert.match(transferStateLabel('returned'),/新反馈/);
  assert.doesNotMatch(transferStateLabel('returned'),/做好|正在处理/);
});
test('feature picker only reads the scoped catalog; choosing cannot create a task or incur a charge',()=>{
  const source=readFileSync(new URL('./ComposerFeatures.tsx',import.meta.url),'utf8');
  assert.match(source,/\/api\/features\?scope=mine/);
  assert.doesNotMatch(source,/method:.*POST|\/api\/coordinator|\/api\/chat|\/runs/);
  assert.match(source,/abort\.abort\(\)/);
  assert.match(source,/selected\.length>=8/);
  assert.match(source,/event\.nativeEvent\.isComposing/);
});
test('member state and plan comparison are separate; explanation remains keyboard accessible',()=>{
  const source=readFileSync(new URL('./MembershipPanel.tsx',import.meta.url),'utf8');
  assert.match(source,/plansOpen\?<SettingsDialog title="选择会员套餐"/);
  assert.match(source,/membership-remaining/);
  const info=readFileSync(new URL('./InfoHint.tsx',import.meta.url),'utf8');
  assert.match(info,/<details/);assert.match(info,/<summary aria-label=/);
});
test('main composer integrates keyboard picker and displays an explicit bound task',()=>{
  const source=readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  assert.match(source,/featurePicker\.keyDown\(event\)/);
  assert.match(source,/发送到任务：/);
  assert.match(source,/回到主对话/);
  assert.match(source,/\["device", "本机执行"\]/);
});
test('tool status check is visible and prevents duplicate checks',()=>{
  const source=readFileSync(new URL('./LocalDeviceSettings.tsx',import.meta.url),'utf8');
  assert.match(source,/if\(executorRequest.current\)return/);
  assert.match(source,/setChecking\(true\)/);
  assert.match(source,/状态已更新/);
  assert.match(source,/尚未确认本机工具/);
});
