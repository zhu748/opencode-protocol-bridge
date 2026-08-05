import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMAGE_HANDOFF_MODELS, normalizeImageHandoffModels } from '../src/config.js';

test('图片交接模型默认覆盖 Zen/Go 的两个 DeepSeek V4 Flash 型号', () => {
  assert.deepEqual(normalizeImageHandoffModels(), DEFAULT_IMAGE_HANDOFF_MODELS);
  assert.deepEqual(new Set(DEFAULT_IMAGE_HANDOFF_MODELS.map((entry) => entry.provider)), new Set(['zen', 'go']));
  assert.equal(DEFAULT_IMAGE_HANDOFF_MODELS.length, 4);
});

test('图片交接模型配置规范化并拒绝重复或非法项', () => {
  assert.deepEqual(normalizeImageHandoffModels([{ provider: ' GO ', model: ' custom-model ' }]), [{ provider: 'go', model: 'custom-model' }]);
  assert.throws(() => normalizeImageHandoffModels('go/model'), /必须是数组/);
  assert.throws(() => normalizeImageHandoffModels([{ provider: 'other', model: 'm' }]), /provider 无效/);
  assert.throws(() => normalizeImageHandoffModels([{ provider: 'go', model: '' }]), /model 无效/);
  assert.throws(() => normalizeImageHandoffModels([{ provider: 'go', model: 'bad\nmodel' }]), /model 无效/);
  assert.throws(() => normalizeImageHandoffModels([
    { provider: 'go', model: 'Model-A' },
    { provider: 'go', model: 'model-a' }
  ]), /重复/);
});
