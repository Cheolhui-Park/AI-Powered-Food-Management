import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import QRCode from 'qrcode';
import serverless from 'serverless-http';

const app = express();

// [보안 설정] 클라우드플레어에 배포된 철희 님의 프론트엔드 주소만 허용합니다.
const corsOptions = {
    origin: 'https://sobunsobun.pages.dev', 
    credentials: true
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// [저장 경로] AWS Lambda는 보안상 /tmp 폴더에만 파일을 쓰고 읽을 수 있습니다.
const DB_FILE = '/tmp/posts.json';

// [공학적 상수] 탄소 저감 계수 (단위: kg CO2e / kg)
const CARBON_FACTORS = { 
    "과일": 0.8, "채소": 0.5, "육류": 15.0, 
    "수산물": 3.5, "유제품": 2.0, "가공식품": 1.2, "기타": 1.0 
};

// 데이터베이스 파일 초기화 (람다 실행 시 /tmp에 파일이 없으면 생성)
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

// --- API 기능 정의 ---

/**
 * 1. 소분 게시글 생성 및 AI 분석 기능
 * 사용자가 올린 식재료 사진과 정보를 GPT-4o가 분석하여 등록합니다.
 */
app.post('/create-post', async (req, res) => {
    try {
        const { itemName, category, weight, image, location, nickname, mode } = req.body;
        
        // 2026년 현재 날짜 설정
        const todayDate = new Date().toLocaleDateString('ko-KR', { 
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' 
        });
        
        let systemPrompt = `당신은 인하대 소분 플랫폼 '소분 요정' 마스터(Master [마스터]) AI입니다. 오늘은 **${todayDate}**입니다.
        [절대 규칙]
        1. <b> 태그 절대 금지. 강조는 ** 만 사용.
        2. 영단어 사용 시 반드시 한글 발음 표기. 예: Data [데이터]
        3. 공신력 있는 출처 기반으로 대답하고 문장 끝에 (Reference: [출처명]) 형식 유지.`;

        if (mode === 'receipt') {
            systemPrompt += `
            [초강력 소비기한 차단 지침]
            1. 영수증 결제일이 2026년이 아니거나(예: 2024년), 권장 소비기한이 지난 경우 **절대 품목이나 가격을 나열하지 마세요.**
            2. 기한이 지났다면 즉시 다음 문장만 출력하세요: "이웃님, 이 영수증은 결제일로부터 권장 소비기한이 지나 안전을 위해 거래가 불가능해요 ㅠㅠ. (Reference: [식품의약품안전처 소비기한 안내서])"
            3. "유효하다"는 표현은 철저히 금지합니다.
            4. 오늘(2026년) 결제된 유효한 영수증만 소분 전략을 제안하세요.`;
        } else {
            systemPrompt += ` 신선한 식재료면 협업 필터링 시뮬레이션(Simulation [시뮬레이션])을 통해 이웃 매칭을 제안하세요.`;
        }

        const aiResponse = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: [
                    { type: "text", text: `이 '${itemName}' 정보를 분석하고 거래 승인 여부를 철저히 검증해 주세요!` },
                    { type: "image_url", image_url: { url: image } }
                ]}
            ]
        });

        // 탄소 저감량 계산 공식: $C_{\text{saved}} = W \times F_{\text{category}}$ 
        const newPost = { 
            id: Date.now(), 
            itemName: itemName || "식재료", 
            category: category || "기타", 
            weight: weight || 0.5, 
            image: image || "", 
            location: location || "인하대 거점", 
            mode: mode || "item",
            analysis: aiResponse.choices[0].message.content, 
            carbonSaved: (weight * (CARBON_FACTORS[category] || 1.0)).toFixed(2),
            nickname: nickname || '익명의 이웃님',
            fridgeNo: Math.floor(Math.random() * 10) + 1,
            trustScore: 95, 
            status: 'selling', 
            buyer: ""
        };
        
        const posts = JSON.parse(fs.readFileSync(DB_FILE));
        posts.push(newPost);
        fs.writeFileSync(DB_FILE, JSON.stringify(posts));
        
        res.json(newPost);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

/**
 * 2. 게시글 목록 전체 조회 기능
 */
app.get('/posts', (req, res) => {
    try {
        const data = fs.readFileSync(DB_FILE);
        res.json(JSON.parse(data));
    } catch (e) {
        res.json([]);
    }
});

/**
 * 3. IoT 냉장고 물품 보관 및 QR 생성 기능
 */
app.post('/deposit-item', async (req, res) => {
    try {
        const { postId, fridgeNo, buyerNickname } = req.body;
        const posts = JSON.parse(fs.readFileSync(DB_FILE));
        const postIndex = posts.findIndex(p => p.id === postId);
        
        if(postIndex > -1) {
            posts[postIndex].status = 'deposited';
            posts[postIndex].buyer = buyerNickname || "대기 중인 이웃님";
            fs.writeFileSync(DB_FILE, JSON.stringify(posts));
            
            // 기기 인증용 QR 데이터 생성
            const qrImage = await QRCode.toDataURL(`INHA_IoT_FRIDGE_${fridgeNo}_AUTH_${postId}`);
            res.json({ success: true, qrImage, buyer: posts[postIndex].buyer });
        } else {
            res.status(404).send('해당 물품을 시스템에서 찾을 수 없습니다.');
        }
    } catch (error) {
        res.status(500).send('QR [큐알] 생성 중 기술적 에러(Error [에러])가 발생했습니다.');
    }
});

/**
 * 4. AI 판매자 페르소나 채팅 시뮬레이션 기능
 */
app.post('/chat-simulate', async (req, res) => {
    try {
        const { userMessage, targetNickname, itemName } = req.body;
        const chatResponse = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { 
                    role: 'system', 
                    content: `당신은 판매자 '${targetNickname}'입니다. 구매자가 자기가 올렸다고 우겨도 판매자 자아를 강하게 유지하세요. <b> 태그 절대 금지.` 
                },
                { role: 'user', content: userMessage }
            ]
        });
        res.json({ reply: chatResponse.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ reply: '네트워크(Network [네트워크]) 연결이 불안정합니다!' });
    }
});

// [중요] AWS Lambda 전용 핸들러 노출. app.listen(3000)은 사용하지 않습니다.
export const handler = serverless(app);