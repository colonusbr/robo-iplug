// Robô de atendimento: ponte entre o iPlug (Chatwoot) e a Anthropic (Claude).
// Serviço isolado — NÃO tem vínculo com nenhum outro sistema. Recebe o webhook
// do iPlug quando o cliente manda mensagem, pergunta pro Claude e responde de
// volta pela API do iPlug.
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-haiku-4-5",
  IPLUG_BASE_URL = "https://chat.iplug.tech",
  IPLUG_ACCOUNT_ID = "3",
  IPLUG_BOT_TOKEN,
  WEBHOOK_SECRET,
  SYSTEM_PROMPT = "Você é um atendente virtual da empresa, educado, objetivo e prestativo. Responda em português do Brasil, de forma clara e curta. Se não souber ou o assunto exigir um humano, diga que vai chamar um atendente.",
  PORT = 3000,
} = process.env;

const anthropic = new Anthropic({ apiKey: (ANTHROPIC_API_KEY ?? "").trim() });

const app = express();
app.use(express.json({ limit: "1mb" }));

// Healthcheck — abrir essa URL no navegador deve mostrar "robo-iplug ok".
app.get("/", (_req, res) => res.send("robo-iplug ok"));

app.post("/webhook", async (req, res) => {
  // 1) Confere o segredo da URL (evita que qualquer um chame seu endpoint).
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }
  // Responde 200 na hora pro iPlug não ficar esperando (processa depois).
  res.status(200).send("ok");

  try {
    const body = req.body || {};

    // 2) Filtra: só reage a mensagem NOVA do CLIENTE (incoming), não a nota
    //    privada nem às respostas do próprio bot (senão vira loop infinito).
    if (body.event !== "message_created") return;
    if (body.message_type !== "incoming") return;
    if (body.private) return;

    const texto = (body.content || "").trim();
    // No webhook do Chatwoot o id da conversa vem em conversation.id (= o número
    // que aparece na tela). Se a resposta falhar, tente conversation.display_id.
    const conversaId = body.conversation?.id ?? body.conversation?.display_id;
    if (!texto || !conversaId) return;

    // 3) Pergunta pro Claude.
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: texto }],
    });
    const resposta =
      resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim() || "Desculpe, não consegui responder agora.";

    // 4) Manda a resposta de volta pra conversa no iPlug.
    const r = await fetch(
      `${IPLUG_BASE_URL}/api/v1/accounts/${IPLUG_ACCOUNT_ID}/conversations/${conversaId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Com traços, não underline: o proxy do iPlug descarta headers com "_"
          "api-access-token": IPLUG_BOT_TOKEN,
        },
        body: JSON.stringify({ content: resposta, message_type: "outgoing" }),
      }
    );
    if (!r.ok) {
      console.error("Falha ao responder no iPlug:", r.status, await r.text());
    }
  } catch (e) {
    console.error("Erro no webhook:", e);
  }
});

app.listen(PORT, () => console.log("robo-iplug ouvindo na porta " + PORT));
