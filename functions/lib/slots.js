// 时间段定义：id 供前端传参，label 必须与飞书多维表格「面试时间」单选选项名完全一致
// 调整时间段时，前端 index.html 里的 TIME_SLOTS 也要同步修改
export const SLOTS = {
  'sat-am': { label: '周六上午 9:00 - 11:00', capacity: 10 },
  'sat-pm': { label: '周六下午 14:00 - 16:00', capacity: 10 },
  'sun-am': { label: '周日上午 9:00 - 11:00', capacity: 10 },
  'sun-pm': { label: '周日下午 14:00 - 16:00', capacity: 10 },
};
