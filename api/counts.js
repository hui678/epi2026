// GET /api/counts —— 查询各时间段已约人数（不暴露任何学生信息）
import { searchRecords } from '../lib/feishu.js';
import { SLOTS } from '../lib/slots.js';
import { CORS_HEADERS, sendJson } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, message: '只支持 GET 请求' });
  }

  try {
    // 对每个时段按「面试时间」单选选项做等值查询
    const entries = await Promise.all(
      Object.entries(SLOTS).map(async ([id, slot]) => {
        const { total } = await searchRecords([
          { field_name: '面试时间', operator: 'is', value: [slot.label] },
        ]);
        return [id, total];
      })
    );
    return sendJson(res, 200, { ok: true, counts: Object.fromEntries(entries) });
  } catch (err) {
    console.error('counts 接口异常：', err);
    return sendJson(res, err.status || 502, {
      ok: false,
      message: err.message || '查询已约人数失败，请稍后重试',
    });
  }
}
