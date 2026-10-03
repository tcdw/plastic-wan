import type { common as commonEn } from '../en/common.ts';

/** Mirrors `en/common.ts` key for key; the annotation fails the build on drift. */
export const common: typeof commonEn = {
  loading: '加载中…',
  noRecords: '暂无记录',
  cancel: '取消',
  confirm: '确认',
  dismiss: '取消',
  working: '处理中…',
  save: '保存',
  saving: '保存中…',
  delete: '删除',
  create: '创建',
  edit: '编辑',
  submit: '提交',
  submitting: '提交中…',
  retry: '重试',
  upload: '上传',
  uploading: '上传中…',
  reload: '重新加载',
  enabled: '已启用',
  disabled: '已禁用',
  on: '开启',
  off: '关闭',
  requestFailed: '请求失败',
  error: '错误',
};
