import { common } from './en/common.ts';
import { image } from './en/image.ts';
import { invocations } from './en/invocations.ts';
import { layout } from './en/layout.ts';
import { models } from './en/models.ts';
import { pages } from './en/pages.ts';

import { common as commonZh } from './zh-CN/common.ts';
import { image as imageZh } from './zh-CN/image.ts';
import { invocations as invocationsZh } from './zh-CN/invocations.ts';
import { layout as layoutZh } from './zh-CN/layout.ts';
import { models as modelsZh } from './zh-CN/models.ts';
import { pages as pagesZh } from './zh-CN/pages.ts';

/**
 * English is the source catalog; every other locale must mirror its key
 * structure (enforced by the `typeof` annotations in each `zh-CN` file).
 * Areas are NESTED, not spread: keys are addressed as `t('area.group.name')`.
 */
const en = {
  common,
  layout,
  invocations,
  models,
  pages,
  image,
};

const zhCN: typeof en = {
  common: commonZh,
  layout: layoutZh,
  invocations: invocationsZh,
  models: modelsZh,
  pages: pagesZh,
  image: imageZh,
};

export { en, zhCN };

export const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN },
};
