const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 配置
const ADMIN_PASSWORD = 'admin123';
const CODES_FILE = path.join(__dirname, 'codes.json');
// 阿里云通义千问 API Key
const QWEN_API_KEY = 'sk-7647cf5239394eca86f010ea55a5e602'; // 用户提供的Key
const MODEL = 'qwen-vl-plus'; // 使用视觉增强模型

// 初始化激活码文件
if (!fs.existsSync(CODES_FILE)) {
    const defaultCodes = [];
    for (let i = 1; i <= 10; i++) {
        defaultCodes.push({
            code: `VIP${String(i).padStart(3, '0')}`,
            used: false,
            deviceId: null,
            usedTime: null
        });
    }
    fs.writeFileSync(CODES_FILE, JSON.stringify(defaultCodes, null, 2));
    console.log('已创建默认激活码文件 codes.json');
}

function getCodes() {
    try {
        return JSON.parse(fs.readFileSync(CODES_FILE));
    } catch (err) {
        return [];
    }
}

function saveCodes(codes) {
    fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
}

// 激活接口（设备绑定）
app.post('/api/activate', (req, res) => {
    try {
        let { code, deviceId } = req.body;
        if (!code || !deviceId) {
            return res.json({ success: false, message: '缺少参数' });
        }
        code = code.trim().toUpperCase();
        const codes = getCodes();
        const found = codes.find(c => c.code === code);
        if (!found) {
            return res.json({ success: false, message: '激活码无效' });
        }
        if (found.used && found.deviceId !== deviceId) {
            return res.json({ success: false, message: '激活码已被其他设备使用' });
        }
        if (!found.used) {
            found.used = true;
            found.deviceId = deviceId;
            found.usedTime = new Date().toLocaleString();
            saveCodes(codes);
        }
        const token = Buffer.from(code + Date.now()).toString('base64');
        res.json({ success: true, message: '激活成功', token });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: '服务器错误' });
    }
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// 后台登录
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const codes = getCodes();
        res.json({
            success: true,
            stats: {
                total: codes.length,
                used: codes.filter(c => c.used).length,
                unused: codes.filter(c => !c.used).length,
                codes: codes
            }
        });
    } else {
        res.json({ success: false });
    }
});

// 批量添加激活码
app.post('/api/admin/addcodes', (req, res) => {
    const { password, newCodes } = req.body;
    if (password !== ADMIN_PASSWORD) return res.json({ success: false });
    const codes = getCodes();
    const existing = new Set(codes.map(c => c.code));
    let added = 0;
    for (let raw of newCodes) {
        const code = raw.trim().toUpperCase();
        if (code && !existing.has(code)) {
            codes.push({ code, used: false, deviceId: null, usedTime: null });
            added++;
        }
    }
    saveCodes(codes);
    res.json({ success: true, added });
});

// 分析接口（调用通义千问多模态模型 - OpenAI 兼容模式）
app.post('/api/analyze', async (req, res) => {
    try {
        const { token, frames, title, caption, category, videoInfo } = req.body;
        if (!token) {
            return res.json({ success: false, message: '请先激活' });
        }

        // 构建提示词
        const prompt = `你是一位专业的短视频爆款诊断专家，擅长分析抖音、快手等平台的视频内容。
用户提供了以下信息：
- 视频标题：${title || '未提供'}
- 视频文案：${caption || '未提供'}
- 视频领域：${category || '未提供'}
- 视频时长：${videoInfo.duration}秒
- 分辨率：${videoInfo.width}×${videoInfo.height}

同时，我给你提供了视频的三张关键帧（第一帧、中间帧、最后一帧），请结合这些信息进行深度分析。

请从以下维度给出评分（0-100分）：
- 内容吸引力（开头3秒、整体内容）
- 标题热度（标题的吸引力、关键词）
- 画面质量（清晰度、亮度、构图）
- 合规性（是否可能有违规内容）
- 互动性（引导用户互动的能力）
- 节奏感（剪辑节奏、时长控制）

然后生成完整的诊断报告，必须包含以下字段，并用严格的JSON格式输出，不要包含其他解释文字：
{
  "score": 整数（综合评分0-100）,
  "dimensions": {
    "content": 整数,
    "title": 整数,
    "quality": 整数,
    "compliance": 整数,
    "interaction": 整数,
    "rhythm": 整数
  },
  "strengths": ["优点1", "优点2", ...]（至少3条）,
  "problems": ["问题1", "问题2", ...]（至少3条）,
  "suggestions": ["修改建议1", "修改建议2", ...]（至少5条）,
  "newTitles": ["新标题1", "新标题2", "新标题3"],
  "newCaption": "优化后的文案（完整一段）",
  "coverAdvice": "封面优化建议"
}`;

        // 构建消息内容（文本 + 图片）
        const userContent = [{ type: 'text', text: prompt }];
        for (let i = 0; i < frames.length; i++) {
            if (frames[i]) {
                userContent.push({
                    type: 'image_url',
                    image_url: { url: frames[i] }  // frames[i] 已经是 data:image/jpeg;base64,...
                });
            }
        }

        const requestBody = {
            model: MODEL,
            messages: [
                {
                    role: 'system',
                    content: '你是专业的短视频内容优化专家，请根据视频信息给出专业建议。'
                },
                {
                    role: 'user',
                    content: userContent
                }
            ],
            temperature: 0.7,
            max_tokens: 2000
        };

        console.log('调用通义千问 API (OpenAI 兼容模式)...');
        const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${QWEN_API_KEY}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('通义千问 API 错误:', response.status, errText);
            throw new Error(`API请求失败: ${response.status}`);
        }

        const data = await response.json();
        const aiContent = data.choices[0].message.content;
        console.log('AI返回内容:', aiContent.substring(0, 300));

        // 提取JSON
        const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('AI返回格式异常');
        }
        const result = JSON.parse(jsonMatch[0]);

        res.json({
            success: true,
            ...result
        });

    } catch (error) {
        console.error('分析失败:', error);
        res.json({
            success: false,
            message: error.message || '分析失败，请稍后重试'
        });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   🚀 后端服务已启动                     ║
    ║   地址: http://localhost:${PORT}        ║
    ║   激活码文件: codes.json               ║
    ║   后台管理密码: ${ADMIN_PASSWORD}        ║
    ║   通义千问模型: ${MODEL}                ║
    ╚════════════════════════════════════════╝
    `);
});