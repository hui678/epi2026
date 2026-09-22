// POST /api/book —— 提交预约（服务端完成全部校验，前端校验仅为体验）
import { createFeishu, FeishuError } from '../lib/feishu.js';
import { SLOTS } from '../lib/slots.js';
import { CORS_HEADERS, jsonResponse } from '../lib/http.js';

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function clean(value, maxLen) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, message: '请求格式错误' });
  }

  // 1. 服务端校验（不信任前端）
  const studentId = clean(body.studentId, 10);
  const name = clean(body.name, 20);
  const className = clean(body.className, 30);
  const slotId = clean(body.slot, 20);

  if (!/^\d{10}$/.test(studentId)) {
    return jsonResponse(400, { ok: false, field: 'studentId', message: '学号必须为 10 位数字' });
  }
  if (!name) {
    return jsonResponse(400, { ok: false, field: 'name', message: '请输入姓名' });
  }
  if (!className) {
    return jsonResponse(400, { ok: false, field: 'className', message: '请输入班级' });
  }
  const slot = SLOTS[slotId];
  if (!slot) {
    return jsonResponse(400, { ok: false, field: 'slot', message: '面试时间不合法' });
  }

  try {
    const feishu = createFeishu(env);

    // 2. 学号查重
    const dup = await feishu.searchRecords([
      { field_name: '学号', operator: 'is', value: [studentId] },
    ]);
    if (dup.total > 0) {
      return jsonResponse(409, {
        ok: false,
        code: 'DUPLICATE_STUDENT',
        message: '该学号已预约过，无需重复提交。如需修改请联系管理员。',
      });
    }

    // 3. 名额校验（服务端权威校验）
    const booked = await feishu.searchRecords([
      { field_name: '面试时间', operator: 'is', value: [slot.label] },
    ]);
    if (booked.total >= slot.capacity) {
      return jsonResponse(409, {
        ok: false,
        code: 'SLOT_FULL',
        message: '该时间段已约满，请选择其他时间。',
      });
    }

    // 4. 写入飞书多维表格（单选字段直接传选项名字符串）
    await feishu.createRecord({
      学号: studentId,
      姓名: name,
      班级: className,
      面试时间: slot.label,
    });

    return jsonResponse(200, { ok: true, slot: { id: slotId, label: slot.label } });
  } catch (err) {
    console.error('book 函数异常：', err);
    if (err instanceof FeishuError) {
      return jsonResponse(err.status, { ok: false, message: err.message });
    }
    return jsonResponse(502, { ok: false, message: '预约失败，请稍后重试或联系管理员' });
  }
}
