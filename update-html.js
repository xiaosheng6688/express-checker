const fs = require('fs');

let html = fs.readFileSync('delivery-checker/index.html', 'utf8');
const originalSize = Buffer.byteLength(html, 'utf8');

// 1. Find and extract the EXPRESS_CODES section to remove it (will be replaced in new query section)
// The new code has EXPRESS_CODES defined inside the query section

// 2. Find the PAYMENT_CONFIG end and add API_BASE_URL after it
const payConfigEnd = html.indexOf('};', html.indexOf('PAYMENT_CONFIG'));
if (payConfigEnd === -1) { console.error('PAYMENT_CONFIG not found'); process.exit(1); }

const apiConfigSection = `};
/* ===================================================================
 *  API 代理地址 - 部署到 Vercel 后自动生效
 * =================================================================== */
const API_BASE_URL = '/api/tracking?nu=';
`;

html = html.slice(0, payConfigEnd + 2) + apiConfigSection + html.slice(payConfigEnd + 2);

// 3. Find and replace the entire query API section
// Search for "Query API" comment marker
const queryStart = html.indexOf(' *  Query API - Multi-strategy');
if (queryStart === -1) { console.error('Query API section not found'); process.exit(1); }

// Find the end - the next "/* ==" after queryWithJSONP function ends
// Look for "Initialize" which comes after
const initStart = html.indexOf('Initialize', queryStart);
if (initStart === -1) { console.error('Initialize section not found'); process.exit(1); }

const newQueryCode = ` *  Query API - 三层降级策略
 * ===================================================================
 * 第一层: Vercel API 代理 (最可靠)
 * 第二层: CORS 免费代理 
 * 第三层: 直接 fetch (开发环境)
 * =================================================================== */

/* ---- 号码规则: 根据单号前缀判断快递公司 ---- */
function detectCompanyByNumber(num) {
  var trimmed = (num || '').trim();
  if (/^SF/i.test(trimmed)) return {code:'shunfeng', name:'顺丰速运'};
  if (/^JD/i.test(trimmed)) return {code:'jd', name:'京东快递'};
  if (/^JT/i.test(trimmed)) return {code:'jtexpress', name:'极兔速递'};
  if (/^E[A-Za-z0-9]{12,}$/.test(trimmed)) return {code:'ems', name:'EMS'};
  if (/^\d{15}$/.test(trimmed)) return {code:'jd', name:'京东快递'};
  if (/^\d{13}$/.test(trimmed)) return {code:'youzhengguonei', name:'中国邮政'};
  return null;
}

/* ---- 快递公司代码映射 ---- */
var EXPRESS_CODES = {
  '中通快递':'zhongtong','圆通速递':'yuantong','申通快递':'shentong',
  '韵达快递':'yunda','极兔速递':'jtexpress','顺丰速运':'shunfeng',
  '中国邮政':'youzhengguonei','EMS':'ems','京东快递':'jd',
  '德邦快递':'debangkuaidi','百世快递':'huitongkuaidi','天天快递':'tiantian',
  '宅急送':'zhaijisong','跨越速运':'kuayue','优速快递':'youshuwuliu',
  '丹鸟物流':'danniao','菜鸟裹裹':'cainiao','丰网速运':'fengwang',
  '中通':'zhongtong','圆通':'yuantong','申通':'shentong',
  '韵达':'yunda','极兔':'jtexpress','顺丰':'shunfeng',
  '京东':'jd','德邦':'debangkuaidi','百世':'huitongkuaidi',
  '天天':'tiantian','优速':'youshuwuliu','丹鸟':'danniao','邮政':'youzhengguonei',
};

/* ---- CORS 代理列表 (备用) ---- */
var PROXY_SERVICES = [
  function(tn){return 'https://api.allorigins.win/raw?url='+encodeURIComponent('https://www.kuaidi100.com/query?type=auto&postid='+encodeURIComponent(tn));},
  function(tn){return 'https://corsproxy.io/?'+encodeURIComponent('https://www.kuaidi100.com/query?type=auto&postid='+encodeURIComponent(tn));},
  function(tn){return 'https://thingproxy.freeboard.io/fetch/'+encodeURIComponent('https://www.kuaidi100.com/query?type=auto&postid='+encodeURIComponent(tn));},
];

/* ---- 主查询函数 ---- */
async function querySingle(trackingNumber) {
  // 策略1: Vercel API 代理 (最可靠，服务端识别快递公司并查询)
  try {
    var resp = await fetch(API_BASE_URL + encodeURIComponent(trackingNumber), {signal:AbortSignal.timeout(12000)});
    if (resp.ok) {
      var result = await resp.json();
      if (result && result.status && result.company) return result;
    }
  } catch(e) {}

  // 策略2: CORS 代理
  for (var i = 0; i < PROXY_SERVICES.length; i++) {
    try {
      var preq = await fetch(PROXY_SERVICES[i](trackingNumber), {signal:AbortSignal.timeout(8000)});
      if (preq.ok) {
        var pdata = JSON.parse(await preq.text());
        var pres = parseKuaidi100Response(pdata, trackingNumber);
        if (pres) return pres;
      }
    } catch(e) {}
  }

  // 策略3: 直接fetch (开发模式可能成功)
  try {
    drl = 'https://www.kuaidi100.com/query?type=auto&postid='+encodeURIComponent(trackingNumber)+'&_='+Date.now();
    var dresp = await fetch(drl, {signal:AbortSignal.timeout(5000)});
    if (dresp.ok) { var d = await dresp.json(); var dr = parseKuaidi100Response(d, trackingNumber); if (dr) return dr; }
  } catch(e) {}

  return null;
}

/* ---- 解析kuaidi100响应 ---- */
function parseKuaidi100Response(data, tn) {
  if (!data) return null;
  if (data.status && data.number && data.company) return data; // 已经是分类结果
  if (data.status !== '200' && data.status !== 200) {
    if (data.data && data.data.length > 0) return processTrackingData(tn, data.com||'未知', data.data, data.state);
    return {number:tn, company:'未知快递', status:'invalid', statusText:'无效单号', message:data&&data.message||'查无此单号', trackingCount:0};
  }
  if (!data.data || !data.data.length) return {number:tn, company:detectCompanyByCode(data.com)||'未知快递', status:'invalid', statusText:'无效单号', message:'暂无物流信息', trackingCount:0};
  return processTrackingData(tn, data.com||'未知', data.data, data.state);
}

function detectCompanyByCode(code) {
  if (!code) return null;
  for (var n in EXPRESS_CODES) { if (EXPRESS_CODES[n] === code) return n; }
  return code;
}

function processTrackingData(tn, companyCode, trackingData, stateCode) {
  var company = detectCompanyByCode(companyCode) || companyCode || '未知快递';
  var count = trackingData.length;
  var latest = trackingData[0] ? (trackingData[0].context || trackingData[0].context_text || '') : '';
  var allTexts = trackingData.map(function(d){return d.context||d.context_text||'';}).join(' ');
  var status, statusText;

  if (count === 0) { status='invalid'; statusText='无效单号'; }
  else if (stateCode === '3' && count >= 2) { status='normal'; statusText='已签收'; }
  else if (stateCode === '5') { status='normal'; statusText='派送中'; }
  else if (stateCode === '0' && count >= 3) { status='normal'; statusText='运输中'; }
  else if (stateCode === '1') {
    if (count <= 2) { status='pending'; statusText='仅揽收'; }
    else { status='empty'; statusText='疑似空包'; }
  } else if (stateCode === '2' || stateCode === '4' || stateCode === '6') {
    status='empty'; statusText='异常/退回';
  } else {
    if (count <= 1) {
      status = /揽收|收件/.test(allTexts) ? 'pending' : 'invalid';
      statusText = /揽收|收件/.test(allTexts) ? '仅揽收' : '无效单号';
    } else if (count <= 3) {
      status = /分拣|中转|发往|到达|派送|签收/.test(allTexts) ? 'normal' : 'empty';
      statusText = status === 'normal' ? '运输中' : '疑似空包';
    } else {
      status='normal'; statusText='运输中';
    }
  }
  if (status !== 'invalid' && /空包|空包裹|虚假|重量为0|0kg|无重量|疑似空/.test(allTexts)) {
    status='empty'; statusText='疑似空包';
  }
  return {number:tn, company:company, status:status, statusText:statusText, message:latest||'暂无物流信息', trackingCount:count};
}`;

html = html.slice(0, queryStart) + newQueryCode + html.slice(initStart);

// 4. Verify results
fs.writeFileSync('delivery-checker/index.html', html, 'utf8');
var newSize = Buffer.byteLength(html, 'utf8');
console.log('Done. Size: ' + (originalSize/1024).toFixed(0) + 'KB -> ' + (newSize/1024).toFixed(0) + 'KB');

// 5. Verify key elements
var checks = ['API_BASE_URL', 'querySingle', 'detectCompanyByNumber', 'processTrackingData', 'PROXY_SERVICES', 'parseKuaidi100Response'];
checks.forEach(function(c) {
  if (html.indexOf(c) > -1) console.log('  OK: ' + c);
  else console.log('  MISSING: ' + c);
});
