// 简单的配额测试 - 请先在浏览器注册账号
// 访问 http://localhost:3000 注册后，按 F12 打开控制台，输入:
// document.cookie
// 复制 vidlive-auth-token= 后面的值，粘贴到下面

const API_URL = 'http://127.0.0.1:8000';
const TOKEN = ''; // ← 粘贴你的 token 到这里

async function quickTest() {
  if (!TOKEN) {
    console.log('⚠️  请先执行以下步骤：');
    console.log('1. 访问 http://localhost:3000');
    console.log('2. 注册/登录账号');
    console.log('3. 按 F12 打开控制台');
    console.log('4. 输入: document.cookie');
    console.log('5. 复制 vidlive-auth-token= 后面的值');
    console.log('6. 粘贴到本文件的 TOKEN 变量中');
    console.log('7. 重新运行: node test-quota-simple.js\n');
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `vidlive-auth-token=${TOKEN}`,
  };

  // 查看配额
  console.log('📊 当前配额使用情况：');
  const usage = await fetch(`${API_URL}/api/v1/usage`, { headers }).then(r => r.json());
  console.log(`   本地: ${usage.localUsed}/${usage.localLimit} (剩余 ${usage.localRemaining})`);
  console.log(`   云端: ${usage.cloudUsed}/${usage.cloudLimit} (剩余 ${usage.cloudRemaining})\n`);

  // 扣除本地配额
  console.log('🔹 扣除本地配额...');
  const local = await fetch(`${API_URL}/api/v1/usage/conversions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'local' }),
  }).then(r => r.json());
  console.log(`   ✅ 本地: ${local.localUsed}/${local.localLimit}\n`);

  // 扣除云端配额
  console.log('☁️  扣除云端配额...');
  const cloud = await fetch(`${API_URL}/api/v1/usage/conversions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'cloud' }),
  }).then(r => r.json());
  console.log(`   ✅ 云端: ${cloud.cloudUsed}/${cloud.cloudLimit}\n`);

  console.log('🎉 测试完成！');
}

quickTest().catch(console.error);
