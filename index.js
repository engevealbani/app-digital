const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client } = require('whatsapp-web.js');
const fs = require('fs');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Função para obter data/hora atual em Brasília (UTC-3)
function getBrasiliaTime() {
    const now = new Date();
    // Ajusta para UTC-3 (Brasília)
    now.setHours(now.getHours() - 3);
    return now;
}

// Configuração de logs com horário de Brasília
const logger = {
  info: (msg) => {
      const now = getBrasiliaTime();
      console.log(`[INFO] ${now.toISOString()} - ${msg}`);
  },
  error: (msg) => {
      const now = getBrasiliaTime();
      console.error(`[ERROR] ${now.toISOString()} - ${msg}`);
  }
};

// Configuração do Express
const app = express();
const PORT = process.env.PORT || 3000;

// Informa ao Express para confiar no proxy do Render (ou outro serviço de hospedagem)
app.set('trust proxy', 1);

// --- Middlewares de Segurança e Funcionalidade ---
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", // Necessário para scripts no HTML
        "https://cdn.tailwindcss.com",
        "https://unpkg.com" 
      ],  
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", // Necessário para estilos no HTML
        "https://fonts.googleapis.com"
      ],
      imgSrc: [
        "'self'", 
        "data:", 
        "https://engevealbani.github.io", // Corrigido
        "https://placehold.co"
      ],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  })
);

app.disable('x-powered-by');  
app.use(cors());
app.use(bodyParser.json());

// Serve os arquivos estáticos (HTML, CSS, JS do cliente) da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));


// Configuração do Rate Limiter para as rotas da API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Muitas requisições. Por favor, tente novamente mais tarde." }
});

app.use('/api/', apiLimiter);


// --- Conexão com o Banco de Dados PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 5000
});

// --- Função para criar as tabelas se não existirem (CORRIGIDA) ---
async function setupDatabase() {
    let clientDB;
    try {
        clientDB = await pool.connect();
        
        // Tabela de clientes (com indentação correta)
        await clientDB.query(`
            CREATE TABLE IF NOT EXISTS clientes (
                telefone VARCHAR(20) PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                endereco TEXT NOT NULL,
                referencia TEXT,
                criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Tabela de pedidos (com indentação correta)
        await clientDB.query(`
            CREATE TABLE IF NOT EXISTS pedidos (
                id SERIAL PRIMARY KEY,
                cliente_telefone VARCHAR(20) NOT NULL REFERENCES clientes(telefone),
                dados_pedido JSONB NOT NULL,
                mensagem_confirmacao_enviada BOOLEAN NOT NULL DEFAULT false,
                mensagem_entrega_enviada BOOLEAN NOT NULL DEFAULT false,
                criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        logger.info('Tabelas verificadas/criadas com sucesso no banco de dados.');
    } catch (err) {
        // O erro original acontecia aqui
        logger.error(`Erro ao criar as tabelas: ${err}`);
    } finally {
        if (clientDB) clientDB.release();
    }
}

// --- Estado e Inicialização do Cliente WhatsApp ---
let whatsappStatus = 'initializing';

const client = new Client({
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  },
});

// --- Função de Normalização de Telefone Atualizada ---
function normalizarTelefone(telefone) {
  if (typeof telefone !== 'string') return null;
 
  // Remove tudo que não for dígito
  let limpo = telefone.replace(/\D/g, '');
 
  // Remove o prefixo '55' se já existir para evitar duplicação
  if (limpo.startsWith('55')) {
    limpo = limpo.substring(2);
  }
    
  // Verifica comprimento após limpeza
  if (limpo.length >= 10 && limpo.length <= 11) {
    // Formato final é sempre 55 + DDD + Numero
    const ddd = limpo.substring(0, 2);
    let numero = limpo.substring(2);
    
    // Remove o nono dígito se ele existir
    if (numero.length === 9 && numero.startsWith('9')) {
      numero = numero.substring(1);
    }
    
    return `55${ddd}${numero}`;
  }
 
  return null;
}

function gerarCupomFiscal(pedido) {
    const { cliente, carrinho, pagamento, troco } = pedido;
    const subtotal = carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
    const taxaEntrega = 5.00;
    const total = subtotal + taxaEntrega;
    const now = getBrasiliaTime();
    
    const dataFormatada = now.toLocaleDateString('pt-BR');
    const horaFormatada = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    
    let cupom = `================================\n`;
    cupom += `Doka Burger - ${dataFormatada} ${horaFormatada}\n`;
    cupom += `================================\n`
    cupom += `👤 *CLIENTE*\nNome: ${cliente.nome}\nFone: ${cliente.telefoneFormatado}\n\n`;
    cupom += `*ITENS DO PEDIDO:*\n`;
    carrinho.forEach(item => {
        const totalItem = `R$ ${(item.preco * item.quantidade).toFixed(2).replace('.', ',')}`;
        cupom += `• ${item.quantidade}x ${item.nome} - ${totalItem}\n`;
        if (item.observacao) { cupom += `  Obs: ${item.observacao}\n`; }
    });
    cupom += `--------------------------------\n`;
    cupom += `Subtotal: R$ ${subtotal.toFixed(2).replace('.', ',')}\n`;
    cupom += `Taxa Entrega: R$ ${taxaEntrega.toFixed(2).replace('.', ',')}\n`;
    cupom += `*TOTAL: R$ ${total.toFixed(2).replace('.', ',')}*\n`;
    cupom += `--------------------------------\n`;
    cupom += `*ENDEREÇO DE ENTREGA:*\n${cliente.endereco}\n`;
    if (cliente.referencia) { cupom += `Ref: ${cliente.referencia}\n`; }
    cupom += `--------------------------------\n`;
    cupom += `*PAGAMENTO:*\n${pagamento}\n`;
    if (pagamento === 'Dinheiro' && troco) {
        const valorTroco = parseFloat(troco.replace(',', '.')) - total;
        cupom += `Troco para: R$ ${parseFloat(troco.replace(',', '.')).toFixed(2).replace('.', ',')} (Levar R$ ${valorTroco.toFixed(2).replace('.',',')})\n`;
    }
    cupom += `================================\n`;
    cupom += `Obrigado pela preferência!`;
    return cupom;
}

// --- Eventos do WhatsApp ---
client.on('qr', qr => {
    logger.info('Gerando QR Code...');
    qrcode.generate(qr, { small: true });
    logger.info(`\nSe o QR Code não aparecer, acesse este link no navegador:\nhttps://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qr)}\n`);
});

client.on('authenticated', (session) => {
    logger.info('Sessão autenticada! Salvando...');
});

client.on('auth_failure', msg => {
    logger.error(`FALHA NA AUTENTICAÇÃO: ${msg}.`);
    whatsappStatus = 'disconnected';
});

client.on('ready', () => {  
    whatsappStatus = 'ready';
    logger.info('✅ 🤖 Cliente WhatsApp conectado e pronto para automação!');
});

client.on('disconnected', (reason) => {  
    whatsappStatus = 'disconnected';  
    logger.error(`WhatsApp desconectado: ${reason}`);  
});

client.initialize().catch(err => {
  logger.error(`Falha crítica ao inicializar o cliente: ${err}`);
});


// --- Rotas da API ---

app.get('/health', (req, res) => {
    res.json({
        whatsapp: whatsappStatus,
        database_connections: pool.totalCount,
        uptime_seconds: process.uptime()
    });
});

app.post('/api/identificar-cliente', async (req, res) => {
    const { telefone } = req.body;
    const numeroCompleto = normalizarTelefone(telefone); 

    if (!numeroCompleto) {
        return res.status(400).json({
            success: false,
            message: "Formato de número de telefone inválido. Use DDD + número."
        });
    }
    
    const telefoneLimpo = numeroCompleto.substring(2); // Remove o '55' para consistência no DB
    const numeroParaApi = `${numeroCompleto}@c.us`;

    try {
        if (whatsappStatus === 'ready') {
            const isRegistered = await client.isRegisteredUser(numeroParaApi);
            if (!isRegistered) {
                return res.status(400).json({
                    success: false,
                    message: "Este número não parece ser uma conta de WhatsApp válida."
                });
            }
        }
    } catch (error) {
        logger.error(`Erro ao verificar número no WhatsApp: ${error.message}`);
    }
    
    let clientDB;
    try {
        clientDB = await pool.connect();
        const result = await clientDB.query('SELECT * FROM clientes WHERE telefone = $1', [telefoneLimpo]);
        
        if (result.rows.length > 0) {
            const clienteEncontrado = result.rows[0];
            logger.info(`Cliente encontrado no DB: ${clienteEncontrado.nome}`);
            res.json({ success: true, isNew: false, cliente: clienteEncontrado });
        } else {
            logger.info(`Cliente novo. Telefone validado: ${telefoneLimpo}`);
            res.json({ success: true, isNew: true, cliente: { telefone: telefoneLimpo } });
        }
    } catch (error) {
        logger.error(`❌ Erro no processo de identificação: ${error.message}`);
        res.status(500).json({ success: false, message: "Erro interno no servidor." });
    } finally {
        if (clientDB) clientDB.release();
    }
});


app.post('/api/criar-pedido', async (req, res) => {
    if (whatsappStatus !== 'ready') {  
        return res.status(503).json({  
            success: false,  
            message: "Servidor de WhatsApp indisponível. Tente novamente em alguns instantes."  
        });  
    }
    
    const pedido = req.body;
    const { cliente } = pedido;
    
    const numeroCompleto = normalizarTelefone(cliente.telefone);

    if (!numeroCompleto) {
        return res.status(400).json({ success: false, message: "Dados do cliente inválidos (telefone)." });
    }
    
    const telefoneLimpo = numeroCompleto.substring(2); // Remove o '55' para o DB
    const numeroClienteParaApi = `${numeroCompleto}@c.us`; // Usa o número completo para o WhatsApp

    if (!cliente || !Array.isArray(pedido.carrinho) || pedido.carrinho.length === 0 || !pedido.pagamento) {
        return res.status(400).json({ success: false, message: "Dados do pedido inválidos." });
    }
    
    pedido.cliente.telefoneFormatado = cliente.telefone; // Guarda o telefone com máscara para o cupom

    let clientDB;
    try {
        clientDB = await pool.connect();
        
        await clientDB.query(
            `INSERT INTO clientes (telefone, nome, endereco, referencia) VALUES ($1, $2, $3, $4)
             ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome, endereco = EXCLUDED.endereco, referencia = EXCLUDED.referencia`,
            [telefoneLimpo, cliente.nome, cliente.endereco, cliente.referencia]
        );
        logger.info(`Cliente "${cliente.nome}" salvo/atualizado no banco de dados.`);
        
        const resultPedido = await clientDB.query(
            `INSERT INTO pedidos (cliente_telefone, dados_pedido)  
             VALUES ($1, $2) RETURNING id`,
            [telefoneLimpo, JSON.stringify(pedido)]
        );
        
        const pedidoId = resultPedido.rows[0].id;
        logger.info(`Pedido #${pedidoId} registrado no banco de dados.`);
        
        const cupomFiscal = gerarCupomFiscal({ ...pedido, id: pedidoId });
        await client.sendMessage(numeroClienteParaApi, cupomFiscal);
        logger.info(`✅ Cupom do pedido #${pedidoId} enviado para ${numeroClienteParaApi}`);
        
        // Mensagens automáticas de acompanhamento
        setTimeout(() => {
            const msgConfirmacao = `✅ PEDIDO CONFIRMADO! 🚀\nSua explosão de sabores está INDO PARA CHAPA🔥️!!! 😋️🍔\n\n⏱ *Tempo estimado:* 40-50 minutos\n📱 *Acompanharemos seu pedido e avisaremos quando sair para entrega!`;
            client.sendMessage(numeroClienteParaApi, msgConfirmacao).catch(err => logger.error(`Falha ao enviar msg de confirmação: ${err.message}`));
        }, 30 * 1000);

        setTimeout(() => {
            const msgEntrega = `🛵 *😋️OIEEE!!! SEU PEDIDO ESTÁ A CAMINHO!* 🔔\nDeve chegar em 10 a 15 minutinhos!\n\n_Se já recebeu, por favor ignore esta mensagem._`;
            client.sendMessage(numeroClienteParaApi, msgEntrega).catch(err => logger.error(`Falha ao enviar msg de entrega: ${err.message}`));
        }, 30 * 60 * 1000);

        res.status(200).json({ success: true, pedidoId: pedidoId });
    } catch (error) {
        logger.error(`❌ Falha ao processar pedido para ${numeroClienteParaApi}: ${error.message}`);
        res.status(500).json({ success: false, message: "Falha ao processar o pedido." });
    } finally {
        if(clientDB) clientDB.release();
    }
});

app.get('/api/historico/:telefone', async (req, res) => {
    const { telefone } = req.params;
    const numeroCompleto = normalizarTelefone(telefone);
    if (!numeroCompleto) {
        return res.status(400).json({ success: false, message: "Formato de número de telefone inválido." });
    }
    const telefoneLimpo = numeroCompleto.substring(2);

    if (!telefoneLimpo) {
        return res.status(400).json({ success: false, message: "Formato de número de telefone inválido." });
    }

    let clientDB;
    try {
        clientDB = await pool.connect();
        
        const result = await clientDB.query(
            `SELECT id, dados_pedido, criado_em FROM pedidos  
             WHERE cliente_telefone = $1  
             ORDER BY criado_em DESC LIMIT 20`,
            [telefoneLimpo]
        );

        if (result.rows.length === 0) {
            return res.json([]);  
        }

        const historico = result.rows.map(pedido => {
            const dados = pedido.dados_pedido;
            return {
                pedidoId: pedido.id,
                dataPedido: pedido.criado_em,
                valorTotal: dados.valorTotal,
                itens: dados.carrinho.map(item => ({
                    nomeProduto: item.nome,
                    quantidade: item.quantidade,
                    observacao: item.observacao || ""
                }))
            };
        });
        
        logger.info(`Histórico de ${historico.length} pedido(s) retornado para o telefone ${telefoneLimpo}`);
        res.json(historico);

    } catch (error) {
        logger.error(`❌ Erro ao buscar histórico para ${telefoneLimpo}: ${error.message}`);
        res.status(500).json({ success: false, message: "Erro interno ao buscar o histórico de pedidos." });
    } finally {
        if (clientDB) clientDB.release();
    }
});

// Rota "pega-tudo" para servir o frontend.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware global para tratamento de erros (deve ser o último)
app.use((err, req, res, next) => {
    logger.error(`Erro não tratado: ${err.stack}`);
    res.status(500).json({ success: false, message: "Ocorreu um erro inesperado no servidor." });
});

// --- Iniciar o Servidor ---
app.listen(PORT, async () => {
    await setupDatabase().catch(logger.error);
    logger.info(`🚀 Servidor rodando na porta ${PORT}.`);
});
