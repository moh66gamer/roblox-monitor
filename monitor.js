const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const USER_ID = process.env.USER_ID || 9511971040;
const COOKIE = process.env.ROBLOX_COOKIE || process.env.ROBLOSECURITY; // يدعم الاسمين لضمان العمل[cite: 3]
const DB_FILE = process.env.DB_PATH || "/data/data.json"; // مسار التخزين الدائم على المجلد المربوط
const PORT = process.env.PORT || 3000;

if (!COOKIE) {
    console.error("خطأ: يجب تحديد متغير البيئة ROBLOX_COOKIE أو ROBLOSECURITY في Railway");
    process.exit(1);
}

let csrfToken = '';

// تحميل البيانات المخزنة مسبقاً
function loadData() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("خطأ في قراءة ملف البيانات:", e);
    }
    return { currentSession: null, history: [] };
}

// حفظ البيانات في الملف
function saveData(data) {
    try {
        const dir = path.dirname(DB_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error("خطأ في حفظ البيانات:", e);
    }
}

let db = loadData();

// دالة مساعدة لطلبات HTTPS لـ Roblox مع تمرير الكوكي وإدارة توكن الحماية
function robloxRequest(method, urlString, bodyData = null, isRetry = false) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Cookie': `.ROBLOSECURITY=${COOKIE}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        };

        if (csrfToken) {
            options.headers['X-CSRF-TOKEN'] = csrfToken;
        }

        if (bodyData) {
            const postData = JSON.stringify(bodyData);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 403 && !isRetry) {
                    const newCsrf = res.headers['x-csrf-token'];
                    if (newCsrf) {
                        csrfToken = newCsrf;
                        return robloxRequest(method, urlString, bodyData, true).then(resolve).catch(reject);
                    }
                }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', err => reject(err));
        if (bodyData) {
            req.write(JSON.stringify(bodyData));
        }
        req.end();
    });
}

// جلب الاسم الرسمي للعبة عبر Universe ID
async function fetchGameName(universeId) {
    if (!universeId) return "لعبة غير معروفة";
    try {
        const res = await robloxRequest('GET', `https://games.roblox.com/v1/games?universeIds=${universeId}`);
        if (res && res.data && res.data.length > 0) {
            return res.data[0].name || `Universe ${universeId}`;
        }
    } catch (e) {
        console.error("فشل جلب اسم اللعبة:", e.message);
    }
    return `Universe ${universeId}`;
}

// فحص حضور اللاعب
async function checkPresence() {
    try {
        const res = await robloxRequest('POST', 'https://presence.roblox.com/v1/presence/users', {
            userIds: [parseInt(USER_ID)]
        });

        if (!res || !res.userPresences || res.userPresences.length === 0) return;

        const presence = res.userPresences[0];
        const type = presence.userPresenceType; // 0: Offline, 1: Online, 2: InGame, 3: InStudio
        const placeId = presence.placeId;
        const universeId = presence.universeId;

        if (type === 2 && placeId) {
            if (!db.currentSession || db.currentSession.placeId !== placeId) {
                if (db.currentSession) {
                    closeCurrentSession();
                }
                const gameName = await fetchGameName(universeId);
                db.currentSession = {
                    placeId: placeId,
                    universeId: universeId,
                    gameName: gameName,
                    startTime: new Date().toISOString()
                };
                saveData(db);
                console.log(`[→] دخل الآن إلى: ${gameName}`);
            }
        } else {
            if (db.currentSession) {
                closeCurrentSession();
            }
        }
    } catch (e) {
        console.error("خطأ أثناء فحص الحضور:", e.message);
    }
}

// إنهاء الجلسة الحالية وحساب المدة
function closeCurrentSession() {
    if (!db.currentSession) return;
    const endTime = new Date();
    const startTime = new Date(db.currentSession.startTime);
    const diffMs = endTime - startTime;
    
    const totalSeconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const durationFormatted = `${minutes} دقيقة و ${seconds} ثانية`;

    const sessionRecord = {
        gameName: db.currentSession.gameName,
        startTime: db.currentSession.startTime,
        endTime: endTime.toISOString(),
        duration: durationFormatted
    };

    db.history.unshift(sessionRecord);
    console.log(`[✓] خرج من اللعبة: ${db.currentSession.gameName} | المدة: ${durationFormatted}`);
    db.currentSession = null;
    saveData(db);
}

// خادم الويب لعرض الجدول (منفذ 3000)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    
    let currentHtml = '<div style="background:#f8d7da;padding:10px;border-radius:5px;margin-bottom:20px;">اللاعب ليس داخل أي لعبة حالياً.</div>';
    if (db.currentSession) {
        currentHtml = `<div style="background:#d4edda;padding:10px;border-radius:5px;margin-bottom:20px;">
            <strong>الحالة الحالية:</strong> يلعب الآن <b>${db.currentSession.gameName}</b> (وقت الدخول: ${new Date(db.currentSession.startTime).toLocaleString()})
        </div>`;
    }

    let rows = '';
    db.history.forEach(item => {
        rows += `<tr>
            <td>${item.gameName}</td>
            <td>${new Date(item.startTime).toLocaleString()}</td>
            <td>${item.duration}</td>
        </tr>`;
    });

    if (rows === '') {
        rows = '<tr><td colspan="3" style="text-align:center;">لا توجد جلسات مسجلة بعد</td></tr>';
    }

    const html = `<!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <title>لوحة مراقبة روبلوكس</title>
        <style>
            body { font-family: Tahoma, sans-serif; background: #f4f7f6; margin: 0; padding: 20px; color: #333; }
            .container { max-width: 900px; margin: auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            h1, h2 { color: #2c3e50; text-align: center; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: right; }
            th { background-color: #2c3e50; color: white; }
            tr:nth-child(even) { background-color: #f9f9f9; }
        </style>
        <meta http-equiv="refresh" content="30">
    </head>
    <body>
        <div class="container">
            <h1>لوحة مراقبة حساب روبلوكس (24/7)</h1>
            ${currentHtml}
            <h2>سجل الجلسات السابقة</h2>
            <table>
                <thead>
                    <tr>
                        <th>اسم اللعبة</th>
                        <th>وقت الدخول</th>
                        <th>المدة</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>
    </body>
    </html>`;
    res.end(html);
});

server.listen(PORT, () => {
    console.log(`خادم الويب يعمل على المنفذ ${PORT}`);
});

checkPresence();
setInterval(checkPresence, 30000);
