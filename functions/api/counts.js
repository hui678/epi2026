// GET /api/counts —— 查询各时间段已约人数（不暴露任何学生信息）
import { createFeishu, FeishuError } from '../lib/feishu.js';
import { SLOTS } from '../lib/slots.js';
import { CORS_HEADERS, jsonResponse } from '../lib/http.js';

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  try {
    const feishu = createFeishu(env);
    // 对每个时段按「面试时间」单选选项做等值查询
    const entries = await Promise.all(
      Object.entries(SLOTS).map(async ([id, slot]) => {
        const { total } = await feishu.searchRecords([
          { field_name: '面试时间', operator: 'is', value: [slot.label] },
        ]);
        return [id, total];
      })
    );
    return jsonResponse(200, { ok: true, counts: Object.fromEntries(entries) });
  } catch (err) {
    console.error('counts 函数异常：', err);
    const status = err instanceof FeishuError ? err.status : 502;
    return jsonResponse(status, { ok: false, message: err.message || '查询已约人数失败，请稍后重试' });
  }
}
