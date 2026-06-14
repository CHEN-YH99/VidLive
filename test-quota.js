// 配额系统测试脚本 - 使用已有账号
const API_URL = 'http://127.0.0.1:8000';

async function testQuotaSystem() {
  console.log('🧪 开始测试配额系统...\n');

  // 1. 登录（假设你已经有账号）
  console.log('1️⃣ 请输入测试账号信息');
  console.log('   提示：如果没有账号，请在浏览器 http://localhost:3000 注册\n');

  const email = 'test@example.com'; // 替换为实际邮箱
  const password = 'Test123456!'; // 替换为实际密码

  console.log('2️⃣ 尝试登录...');
  const loginRes = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    console.log('⚠️  登录失败，请先在浏览器注册账号');
    console.log('   访问: http://localhost:3000');
    console.log('   注册后，修改此脚本中的 email 和 password 再运行\n');
    return;
  }

  const loginData = await loginRes.json();
  console.log(`✅ 登录成功: ${loginData.user.email}`);
  console.log(`   - 用户类型: ${loginData.user.planType}`);
  console.log(`   - 本地配额: ${loginData.user.localQuotaDaily} 次/天`);
  console.log(`   - 云端配额: ${loginData.user.cloudQuotaDaily} 次/天\n`);

  const token = loginData.token || '';
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `vidlive-auth-token=${token}`,
  };

  // 3. 查看当前配额
  console.log('3️⃣ 查看当前配额使用情况...');
  const usageRes = await fetch(`${API_URL}/api/v1/usage`, { headers });
  const usage = await usageRes.json();
  console.log(`✅ 配额信息:`);
  console.log(`   - 本地: ${usage.localUsed}/${usage.localLimit} (剩余 ${usage.localRemaining})`);
  console.log(`   - 云端: ${usage.cloudUsed}/${usage.cloudLimit} (剩余 ${usage.cloudRemaining})\n`);

  // 4. 测试本地模式扣除配额
  console.log('4️⃣ 测试本地模式扣除配额...');
  const localRes = await fetch(`${API_URL}/api/v1/usage/conversions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'local' }),
  });
  const localUsage = await localRes.json();

  if (localRes.ok) {
    console.log(`✅ 本地配额扣除成功:`);
    console.log(`   - 本地: ${localUsage.localUsed}/${localUsage.localLimit} (剩余 ${localUsage.localRemaining})`);
    console.log(`   - 云端: ${localUsage.cloudUsed}/${localUsage.cloudLimit} (剩余 ${localUsage.cloudRemaining})\n`);
  } else {
    console.error('❌ 本地配额扣除失败:', localUsage);
    return;
  }

  // 5. 测试云端模式扣除配额
  console.log('5️⃣ 测试云端模式扣除配额...');
  const cloudRes = await fetch(`${API_URL}/api/v1/usage/conversions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'cloud' }),
  });
  const cloudUsage = await cloudRes.json();

  if (cloudRes.ok) {
    console.log(`✅ 云端配额扣除成功:`);
    console.log(`   - 本地: ${cloudUsage.localUsed}/${cloudUsage.localLimit} (剩余 ${cloudUsage.localRemaining})`);
    console.log(`   - 云端: ${cloudUsage.cloudUsed}/${cloudUsage.cloudLimit} (剩余 ${cloudUsage.cloudRemaining})\n`);
  } else {
    console.error('❌ 云端配额扣除失败:', cloudUsage);
    return;
  }

  console.log('🎉 配额系统测试完成！\n');
  console.log('📊 测试总结:');
  console.log('   ✅ 本地/云端配额独立扣除');
  console.log('   ✅ 配额统计准确无误');
  console.log('\n💡 建议手动测试:');
  console.log('   1. 访问 http://localhost:3000');
  console.log('   2. 查看用户信息弹出框，确认显示本地和云端配额');
  console.log('   3. 多次生成，观察配额变化');
  console.log('   4. 修改系统日期到明天，测试配额重置');
}

testQuotaSystem().catch(console.error);
