import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(scrypt);
const cookieName='__Host-rahban_operator';
const cookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function passwordHash(password){const salt=randomBytes(16).toString('hex');return salt+':'+(await derive(password,salt,64)).toString('hex');}
export function installAccess(app,{origin,passwordHash:hash,username='rahban'}){
  if(!origin)return {public:false};
  const parsed=new URL(origin);
  if(parsed.protocol!=='https:'||parsed.origin!==origin||!/^([a-f0-9]{32}):([a-f0-9]{128})$/.test(hash||''))throw new Error('Public hosting requires an exact HTTPS origin and a scrypt operator password hash.');
  const [salt,expected]=hash.split(':'),logins=new Map(),challenges=new Map(),attempts=new Map();
  const options={httpOnly:true,secure:true,sameSite:'strict',path:'/'};
  const now=()=>Date.now();
  function prune(map){for(const [key,row]of map)if(row.expires<now())map.delete(key);if(map.size>=1000)map.delete(map.keys().next().value);}
  function page(message='',nonce=''){
    return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ورود به راه‌بان</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0d1319;color:#e9efe9;font:16px Tahoma,sans-serif}main{width:min(350px,80vw);padding:36px;background:#151e25;border:1px solid #2e3d38;border-radius:22px}small{color:#b4e786;letter-spacing:3px}h1{font-size:30px}p{color:#a0adb4;line-height:1.9;font-size:14px}label{display:block;font-size:14px;margin-top:22px}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:9px;border:1px solid #3a4849;border-radius:9px;background:#0c141a;color:#edf3ed;font:inherit}button{margin-top:28px;background:#b4e786;color:#162111;border:0;cursor:pointer;font-weight:bold}.error{color:#ffbf9c}</style><main><small>RAHBAN / OPERATIONS</small><h1>به راه‌بان وارد شوید.</h1><p>پنل انتشار و پایداری شما، روی سرور.<br>برای دسترسی، مشخصات اپراتور را وارد کنید.</p>${message?`<p class="error" role="alert">${escape(message)}</p>`:''}<form method="post" action="/auth/login"><input type="hidden" name="nonce" value="${nonce}"><label>نام کاربری<input name="username" dir="ltr" autocomplete="username" required maxlength="80"></label><label>رمز ورود<input name="password" type="password" dir="ltr" autocomplete="current-password" required maxlength="200"></label><button type="submit">ورود به مرکز عملیات</button></form></main></html>`;
  }
  app.use((req,res,next)=>{
    // The internal synthetic sandbox never exposes control-plane data.
    const internal=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&['localhost','127.0.0.1'].includes((req.headers.host||'').split(':')[0]);
    if(req.path==='/healthz'&&req.method==='GET')return next();
    if(internal&&req.path==='/sandbox'&&req.method==='GET')return next();
    if(req.headers.host!==parsed.host)return res.status(403).send('Host is not allowed.');
    const source=req.get('origin');if(source&&source!==origin)return res.status(403).send('Origin is not allowed.');
    res.set('Cache-Control','no-store');
    if(req.path==='/auth/login')return next();
    const session=logins.get(cookie(req,cookieName));
    if(!session||session.expires<now()){
      if(req.path.startsWith('/api/')||req.path==='/metrics')return res.status(401).json({error:'ابتدا وارد پنل شوید.',loginRequired:true});
      return res.redirect(303,'/auth/login');
    }
    req.operator=true;next();
  });
  app.get('/auth/login',(req,res)=>{prune(challenges);const nonce=randomBytes(32).toString('hex');challenges.set(nonce,{expires:now()+300000});res.cookie('__Host-rahban_login',nonce,{...options,maxAge:300000});res.type('html').send(page(req.query.failed?'نام کاربری یا رمز ورود درست نیست.':'',nonce));});
  app.post('/auth/login',async(req,res,next)=>{
    try{
      const nonce=cookie(req,'__Host-rahban_login'),challenge=challenges.get(nonce);challenges.delete(nonce);
      if(!challenge||challenge.expires<now()||req.body.nonce!==nonce)return res.status(403).type('html').send(page('فرم منقضی شد؛ صفحه را تازه کنید.'));
      prune(attempts);const address=req.socket.remoteAddress||'unknown',attempt=attempts.get(address)||{count:0,expires:now()+900000};
      if(attempt.count>=12)return res.status(429).set('Retry-After','900').type('html').send(page('تلاش‌های ورود زیاد است؛ ۱۵ دقیقه بعد دوباره امتحان کنید.'));
      attempt.count++;attempts.set(address,attempt);
      const password=String(req.body.password||'');
      const actual=await derive(password.slice(0,200),salt,64);
      if(!timingSafeEqual(actual,Buffer.from(expected,'hex'))||req.body.username!==username)return res.redirect(303,'/auth/login?failed=1');
      attempts.delete(address);prune(logins);const sid=randomBytes(32).toString('hex');logins.set(sid,{expires:now()+8*3600000});
      res.clearCookie('__Host-rahban_login',options);res.cookie(cookieName,sid,{...options,maxAge:8*3600000});res.redirect(303,'/');
    }catch(error){next(error);}
  });
  app.post('/auth/logout',(req,res)=>{logins.delete(cookie(req,cookieName));res.clearCookie(cookieName,options);res.redirect(303,'/auth/login');});
  return {public:true};
}
