/**
 * Vercel Serverless Function - 快递查询 API 代理
 * 
 * 解决浏览器跨域限制 + 自动识别快递公司
 * 部署到 Vercel 后可通过 /api/tracking?nu=单号 访问
 */
export default async function handler(req, res) {
  // 跨域头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { nu } = req.query;
  if (!nu || String(nu).trim().length < 6) {
    return res.status(400).json({ error: '请提供有效的快递单号' });
  }

  const trackingNumber = String(nu).trim();

  try {
    // 第一步：自动识别快递公司
    const companyInfo = await detectCompany(trackingNumber);
    if (!companyInfo) {
      return res.json({
        number: trackingNumber,
        company: '未知快递',
        status: 'invalid',
        statusText: '无法识别',
        message: '未能识别该单号所属快递公司，请确认单号是否正确',
        trackingCount: 0
      });
    }

    // 第二步：查询物流
    const trackingData = await queryTracking(trackingNumber, companyInfo.code);
    if (!trackingData) {
      return res.json({
        number: trackingNumber,
        company: companyInfo.name,
        status: 'invalid',
        statusText: '查询失败',
        message: '物流API暂无响应，请稍后重试',
        trackingCount: 0
      });
    }

    // 第三步：解析分类
    const result = classifyTracking(trackingNumber, companyInfo.name, trackingData);
    return res.json(result);

  } catch (err) {
    return res.json({
      number: trackingNumber,
      company: '未知快递',
      status: 'invalid',
      statusText: '查询异常',
      message: err.message || '系统异常',
      trackingCount: 0
    });
  }
}

/**
 * 快递公司识别 - 先尝试号码规则，再调用API
 */
async function detectCompany(trackingNumber) {
  // 先按号码规则匹配
  const matched = matchByPattern(trackingNumber);
  if (matched) return matched;

  // 再调API自动识别
  try {
    const resp = await fetch(`https://www.kuaidi100.com/autonumber/autoComNum?text=${encodeURIComponent(trackingNumber)}`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await resp.json();
    if (data.auto && data.auto.length > 0) {
      const comCode = data.auto[0].comCode;
      return { code: comCode, name: getCompanyName(comCode) };
    }
  } catch(e) {
    // fall through
  }

  return null;
}

/**
 * 号码规则匹配
 */
function matchByPattern(num) {
  const patterns = [
    // 顺丰: SF开头+12位数字
    { pattern: /^SF\d{12}$/i, code: 'shunfeng', name: '顺丰速运' },
    // 京东: 纯15位数字，或JD开头
    { pattern: /^(JD|JDX|JDK)\d+/i, code: 'jd', name: '京东快递' },
    { pattern: /^\d{15}$/, code: 'jd', name: '京东快递' },
    // EMS: 以E开头+13位数字
    { pattern: /^E[A-Z0-9]{13}$/i, code: 'ems', name: 'EMS' },
    // 邮政: 纯13位数字
    { pattern: /^\d{13}$/, code: 'youzhengguonei', name: '中国邮政' },
    // 中通: 12位纯数字，常见以 7/8/9开头
    { pattern: /^[789]\d{11}$/, code: 'zhongtong', name: '中通快递' },
    // 圆通: 12位纯数字，常见以 1/2/3/4/5/6/8/9开头
    { pattern: /^[1-9]\d{11}$/, code: 'yuantong', name: '圆通速递' },
    // 申通: 12位纯数字，常见以 4/5/7/8/9开头
    { pattern: /^\d{12}$/, code: 'shentong', name: '申通快递' },
    // 韵达: 13位数字
    { pattern: /^\d{13}$/, code: 'yunda', name: '韵达快递' },
    // 极兔: JT开头+数字
    { pattern: /^JT\d+/i, code: 'jtexpress', name: '极兔速递' },
    // 德邦: 8位或10位数字
    { pattern: /^\d{8,10}$/, code: 'debangkuaidi', name: '德邦快递' },
  ];

  for (const p of patterns) {
    if (p.pattern.test(num)) {
      return { code: p.code, name: p.name };
    }
  }
  return null;
}

/**
 * 查询物流轨迹
 */
async function queryTracking(num, companyCode) {
  const url = `https://www.kuaidi100.com/query?type=${encodeURIComponent(companyCode)}&postid=${encodeURIComponent(num)}`;
  
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TrackingBot/1.0)',
      'Referer': 'https://www.kuaidi100.com/'
    }
  });

  if (!resp.ok) return null;
  return await resp.json();
}

/**
 * 分类判断
 */
function classifyTracking(number, companyName, data) {
  if (!data || data.status !== '200' && data.status !== 200) {
    const msg = data?.message || '';
    if (msg.includes('查无') || msg.includes('不存在') || msg.includes('无效')) {
      return { number, company: companyName, status: 'invalid', statusText: '无效单号', message: msg, trackingCount: 0 };
    }
    if (data?.data?.length > 0) {
      // 有些情况status不为200但仍有数据
      return processData(number, companyName, data.data, data.state);
    }
    return { number, company: companyName, status: 'invalid', statusText: '查无此单', message: msg || '暂无物流信息', trackingCount: 0 };
  }

  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    return { number, company: companyName, status: 'invalid', statusText: '无效单号', message: '暂无物流信息', trackingCount: 0 };
  }

  return processData(number, companyName, data.data, data.state);
}

function processData(number, companyName, trackingData, stateCode) {
  const count = trackingData.length;
  const latest = trackingData[0]?.context || trackingData[0]?.context_text || '';
  const allContexts = trackingData.map(d => (d.context || d.context_text || '')).join(' ');

  let status, statusText;

  if (count === 0) {
    status = 'invalid';
    statusText = '无效单号';
  } else if (stateCode === '3' && count >= 2) {
    status = 'normal';
    statusText = '已签收';
  } else if (stateCode === '5') {
    status = 'normal';
    statusText = '派送中';
  } else if (stateCode === '0' && count >= 3) {
    status = 'normal';
    statusText = '运输中';
  } else if (stateCode === '3' || stateCode === '5' || stateCode === '0') {
    const hasPickup = /揽收|收件|已收|已取/.test(allContexts);
    const hasMovement = /分拣|中转|发往|到达|派送|签收/.test(allContexts);
    if (hasPickup && !hasMovement) {
      status = 'pending';
      statusText = '仅揽收';
    } else if (hasMovement) {
      status = 'normal';
      statusText = '运输中';
    } else {
      status = count <= 2 ? 'empty' : 'normal';
      statusText = count <= 2 ? '疑似空包' : '运输中';
    }
  } else if (stateCode === '1') {
    status = count <= 2 ? 'pending' : 'empty';
    statusText = count <= 2 ? '仅揽收' : '疑似空包';
  } else if (stateCode === '2' || stateCode === '4' || stateCode === '6') {
    status = 'empty';
    statusText = '异常/退回';
  } else {
    if (count <= 1) {
      status = /揽收|收件/.test(allContexts) ? 'pending' : 'invalid';
      statusText = /揽收|收件/.test(allContexts) ? '仅揽收' : '无效单号';
    } else if (count <= 3) {
      const hasMovement = /分拣|中转|发往|到达|派送|签收/.test(allContexts);
      status = hasMovement ? 'normal' : 'empty';
      statusText = hasMovement ? '运输中' : '疑似空包';
    } else {
      status = 'normal';
      statusText = '运输中';
    }
  }

  // 空包关键词检测
  if (status !== 'invalid' && /空包|空包裹|虚假|重量为0|0kg|无重量|疑似空/.test(allContexts)) {
    status = 'empty';
    statusText = '疑似空包';
  }

  return { number, company: companyName, status, statusText, message: latest || '暂无物流信息', trackingCount: count };
}

function getCompanyName(code) {
  const map = {
    'zhongtong': '中通快递', 'yuantong': '圆通速递', 'shentong': '申通快递',
    'yunda': '韵达快递', 'jtexpress': '极兔速递', 'shunfeng': '顺丰速运',
    'youzhengguonei': '中国邮政', 'ems': 'EMS', 'jd': '京东快递',
    'debangkuaidi': '德邦快递', 'huitongkuaidi': '百世快递', 'tiantian': '天天快递',
    'zhaijisong': '宅急送', 'kuayue': '跨越速运', 'youshuwuliu': '优速快递',
    'danniao': '丹鸟物流', 'cainiao': '菜鸟裹裹', 'fengwang': '丰网速运'
  };
  return map[code] || code;
}
