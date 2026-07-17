// Robô de atendimento: ponte entre o iPlug (Chatwoot) e a Anthropic (Claude).
// Serviço isolado — NÃO tem vínculo com nenhum outro sistema. Recebe o webhook
// do iPlug quando o cliente manda mensagem, pergunta pro Claude e responde de
// volta pela API do iPlug.
import express from "express";
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-haiku-4-5",
  IPLUG_BASE_URL = "https://chat.iplug.tech",
  IPLUG_ACCOUNT_ID = "3",
  IPLUG_BOT_TOKEN,
  WEBHOOK_SECRET,
  SYSTEM_PROMPT,
  PORT = 3000,
} = process.env;

// A personalidade do robô vive no arquivo prompt.txt (no GitHub, junto do
// código). Pra atualizar o personagem: trocar o prompt.txt e reimplantar.
// Ordem de prioridade: prompt.txt > variável SYSTEM_PROMPT > texto padrão.
function carregarPersonalidade() {
  try {
    const txt = fs.readFileSync(new URL("./prompt.txt", import.meta.url), "utf8").trim();
    if (txt) return txt;
  } catch {}
  return (
    SYSTEM_PROMPT ||
    "Você é um atendente virtual educado, objetivo e prestativo. Responda em português do Brasil, de forma clara e curta."
  );
}
const PERSONALIDADE = carregarPersonalidade();

const anthropic = new Anthropic({ apiKey: (ANTHROPIC_API_KEY ?? "").trim() });

const app = express();
app.use(express.json({ limit: "1mb" }));

// Headers pra falar com a API do iPlug.
// IMPORTANTE: com traços, não underline. O proxy do iPlug descarta headers com "_".
const headersIplug = {
  "Content-Type": "application/json",
  "api-access-token": IPLUG_BOT_TOKEN,
};

// Busca as últimas mensagens da conversa no iPlug pra dar memória ao robô.
// Se falhar por qualquer motivo, o robô segue só com a mensagem atual.
async function buscarHistorico(conversaId, textoAtual) {
  const fallback = [{ role: "user", content: textoAtual }];
  try {
    const r = await fetch(
      `${IPLUG_BASE_URL}/api/v1/accounts/${IPLUG_ACCOUNT_ID}/conversations/${conversaId}/messages`,
      { headers: headersIplug }
    );
    if (!r.ok) return fallback;
    const dados = await r.json();
    const lista = Array.isArray(dados?.payload) ? dados.payload : [];

    const historico = [];
    for (const m of lista) {
      if (m.private) continue; // nota interna do time, cliente não vê
      const texto = (m.content || "").trim();
      if (!texto) continue;
      // message_type: 0 = cliente (incoming), 1 = loja (outgoing)
      const tipo = m.message_type;
      if (tipo === 0 || tipo === "incoming") {
        historico.push({ role: "user", content: texto });
      } else if (tipo === 1 || tipo === "outgoing") {
        historico.push({ role: "assistant", content: texto });
      }
    }

    // Mantém só as últimas 20 mensagens pra conversa não ficar gigante.
    let msgs = historico.slice(-20);
    // A conversa precisa começar com mensagem do cliente.
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    // E terminar com a mensagem atual do cliente.
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") {
      msgs.push({ role: "user", content: textoAtual });
    }
    return msgs.length ? msgs : fallback;
  } catch {
    return fallback;
  }
}

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

    // 3) Monta a conversa com memória e pergunta pro Claude.
    const mensagens = await buscarHistorico(conversaId, texto);
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system: PERSONALIDADE,
      messages: mensagens,
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
        headers: headersIplug,
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
