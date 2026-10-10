const axios = require('axios');
const { APP_KEY, SECRET_KEY } = require('./src/config/env');
const toFormData = (obj) => Object.keys(obj).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');

async function testEzopen() {
  const tokenRes = await axios.post('https://open.ezvizlife.com/api/lapp/token/get', toFormData({
    appKey: APP_KEY,
    appSecret: SECRET_KEY
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  
  const token = tokenRes.data.data.accessToken;
  const areaDomain = tokenRes.data.data.areaDomain; // https://ivnopen.ezvizlife.com

  console.log('Domain:', areaDomain);

  // Test url/ezopen
  const formData = new URLSearchParams();
  formData.append('isFlv', 'false');
  formData.append('isHttp', 'false');
  formData.append('needStreamToken', '1');
  formData.append('accessToken', token);
  formData.append('ezopen', 'ezopen://open.ezviz.com/AC6527557/1.hd.live');

  try {
    const res1 = await axios.post(areaDomain + '/api/lapp/live/url/ezopen', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'sdkVersion': '9.0.22'
      }
    });
    console.log('url/ezopen without code:');
    console.log(res1.data);
  } catch (err) {
    console.log('Error 1:', err.response?.data || err.message);
  }

  // Test url/ezopen with Gravity01 code
  const formData2 = new URLSearchParams();
  formData2.append('isFlv', 'false');
  formData2.append('isHttp', 'false');
  formData2.append('needStreamToken', '1');
  formData2.append('accessToken', token);
  formData2.append('ezopen', 'ezopen://Gravity01@open.ezviz.com/AC6527557/1.hd.live');

  try {
    const res2 = await axios.post(areaDomain + '/api/lapp/live/url/ezopen', formData2.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'sdkVersion': '9.0.22'
      }
    });
    console.log('url/ezopen with Gravity01:');
    console.log(res2.data);
  } catch (err) {
    console.log('Error 2:', err.response?.data || err.message);
  }
}

testEzopen().catch(console.error);
