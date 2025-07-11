const fs = require('fs');

class ClientesManager {
    constructor(logger) {
        this.CLIENTES_PATH = './data/clientes.json';
        this.logger = logger;
        this.clientes = [];
        this.initialize();
    }

    initialize() {
        // Cria o diretório 'data' se não existir
        const dir = './data';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
            this.logger.info('Diretório data/ criado com sucesso.');
        }

        // Carrega clientes do arquivo ou inicia com array vazio
        if (fs.existsSync(this.CLIENTES_PATH)) {
            try {
                this.clientes = JSON.parse(fs.readFileSync(this.CLIENTES_PATH, 'utf-8'));
                this.logger.info(`Clientes carregados do arquivo (${this.clientes.length} registros).`);
            } catch (err) {
                this.logger.error('Erro ao ler clientes.json. Iniciando com lista vazia.');
                this.clientes = [];
            }
        } else {
            this.clientes = [];
            this.salvar(); // Cria o arquivo vazio
            this.logger.info('Novo arquivo clientes.json criado.');
        }
    }

    salvar() {
        try {
            fs.writeFileSync(this.CLIENTES_PATH, JSON.stringify(this.clientes, null, 2));
            this.logger.info('Clientes salvos em clientes.json');
            return true;
        } catch (err) {
            this.logger.error('Erro ao salvar clientes.json: ' + err.message);
            return false;
        }
    }

    buscarPorTelefone(telefone) {
        return this.clientes.find(cliente => cliente.telefone === telefone);
    }

    adicionar(cliente) {
        if (!cliente.telefone || !cliente.nome || !cliente.endereco) {
            this.logger.error('Dados do cliente incompletos');
            return false;
        }

        // Verifica se já existe
        const existente = this.buscarPorTelefone(cliente.telefone);
        if (existente) {
            return false;
        }

        // Adiciona novo cliente
        this.clientes.push({
            telefone: cliente.telefone,
            nome: cliente.nome,
            endereco: cliente.endereco,
            referencia: cliente.referencia || '',
            cadastradoEm: new Date().toISOString()
        });

        return this.salvar();
    }

    atualizar(telefone, dadosAtualizados) {
        const index = this.clientes.findIndex(c => c.telefone === telefone);
        if (index === -1) return false;

        this.clientes[index] = {
            ...this.clientes[index],
            ...dadosAtualizados,
            atualizadoEm: new Date().toISOString()
        };

        return this.salvar();
    }

    listarTodos() {
        return this.clientes;
    }
}

module.exports = ClientesManager;
