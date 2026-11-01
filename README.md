![Inference Gateway: operação de modelos](docs/assets/banner.svg)

# Inference Gateway

Uma camada de entrada para aplicações que chamam modelos de IA. Ela controla o consumo por cliente e aplica políticas de timeout, fallback, circuit breaker e concorrência antes de devolver a resposta do provedor.

**Entrada autenticada · orçamento diário persistente · adaptação ao Ollama**

O serviço foi implementado em TypeScript sobre Node.js, com SQLite para contabilização. Os modelos são configurados pelo operador e podem executar localmente.

## Políticas de operação

- Timeout por tentativa; aborta a requisição HTTP e tenta o próximo provedor.
- O circuito abre após o número configurado de falhas consecutivas; depois do cooldown, uma única chamada testa a recuperação.
- O limite por minuto é por cliente, em memória. A janela inicia na primeira chamada.
- O orçamento diário conta requisições aceitas, inclusive falhas. A reserva é transacional e persistente. Reiniciar não zera esse contador.
- Concorrência acima do limite devolve 503 e `Retry-After`. Não existe fila oculta.
- A resposta contém requestId, provedor usado, tentativas, fallback, latência e tokens informados pelo modelo.

O pior tempo nominal de uma requisição é o número de provedores multiplicado pelo timeout individual. São aceitos no máximo quatro provedores. O cliente deve usar timeout compatível. Uma chamada abortada pode continuar consumindo recursos no servidor do modelo: cancelar HTTP não garante cancelar a inferência interna.

## Uma chamada pelo gateway

O exemplo registra inferência no Ollama, resposta e contabilização. O relatório separado documenta também um cenário de falha do provedor principal e uso do backup.

![Inferência e consumo registrados](docs/assets/screenshot.jpg)

[Painel da chamada](docs/demo/index.html) · [Dados capturados](docs/demo/run.json) · [Integração e failover](reports/ollama-integration.json)

<details><summary>Ver as etapas em movimento</summary>

![Etapas da inferência](docs/assets/demo.gif)

</details>

## Rodar

Requer Node.js 24+. Não há dependência de runtime além do Node. O SQLite embutido pode emitir aviso experimental.

```powershell
npm ci
Copy-Item .env.example .env
npm run typecheck
npm test
npm run demo
npm start
```

`npm run demo` injeta uma falha no primeiro provedor e mostra o fallback, o circuito aberto e a contabilização. Não depende de `.env` ou de um modelo baixado.

```powershell
$headers = @{Authorization='Bearer demo-client-a'}
$body = @{prompt='Explique validacao temporal em duas frases.'} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8006/v1/infer -Method Post -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod http://127.0.0.1:8006/v1/usage -Headers $headers
Invoke-RestMethod http://127.0.0.1:8006/health
```

Cada chave está vinculada a um cliente. Campos de cliente enviados no corpo não alteram essa identidade. `/v1/usage` consulta apenas o consumo daquele cliente no dia UTC atual. O banco fica em `var/usage.sqlite`; prompts e respostas não são gravados nele.

Os totais de tokens somam somente valores informados pelo provedor final bem-sucedido. `requestsWithInputTokens` e `requestsWithOutputTokens` mostram quantas chamadas contribuíram para cada soma; se nenhuma informou o valor, a soma é `null`. Tentativas anteriores que falharam podem ter consumido tokens não contabilizados. Esses campos não são uma fatura completa dos provedores.

## Componentes e responsabilidades

![Fluxo de dados e componentes do Inference Gateway](docs/assets/architecture.svg)

Autenticação por cliente, políticas por tentativa, roteamento entre provedores e contabilização transacional. Veja as [decisões técnicas](docs/architecture.md).

## Modelos reais

Instale o Ollama separadamente e obtenha os modelos que pretende usar. Configure `.env`, por exemplo:

```text
PROVIDERS_JSON=[{"id":"primary","kind":"ollama","baseUrl":"http://127.0.0.1:11434","model":"SEU_MODELO_PRINCIPAL"},{"id":"backup","kind":"ollama","baseUrl":"http://127.0.0.1:11434","model":"SEU_MODELO_RESERVA"}]
PROVIDER_TIMEOUT_MS=30000
```

Os nomes são exemplos: substitua por modelos que você baixou. A ordem define a prioridade. Dois modelos no mesmo servidor compartilham o risco de indisponibilidade; servidores separados permitem testar falhas independentes. O gateway usa `/api/generate`, com `stream=false` e saída limitada a 512 tokens pelo pedido ao provedor. Tokens de entrada e saída vêm da resposta do Ollama; quando ausentes, ficam `null`. Não há estimativa fictícia de custo financeiro.

## Verificação e limites

Os testes cobrem falha, timeout, fallback, circuito half-open, limite de concorrência, persistência do orçamento, autenticação, isolamento de consumo e protocolo HTTP do Ollama com um servidor local controlado. Eles não avaliam a qualidade de respostas de modelos reais.

`npm run verify:ollama` executa uma verificação complementar com Ollama real: inferência pela API em execução, contabilização de tokens e failover HTTP de um primário inacessível para um backup real. O [procedimento de integração](docs/ollama-integration.md) explica os modelos, a configuração e o que o relatório comprova.

O [relatório versionado](reports/ollama-integration.json) registra o teste aprovado com Qwen2.5 1.5B: resposta do gateway em contêiner, tokens reais e duas chamadas da instância de failover, com o primário pulado na segunda chamada porque o circuito estava aberto. A suíte isolada tem 11 testes aprovados e a verificação de tipos passou.

Este serviço é pensado para um único processo. Rate limit e circuitos são locais a esse processo; para múltiplas réplicas, esses estados precisariam de armazenamento compartilhado. Se o processo cair durante uma chamada, a reserva fica `running` e continua contando no orçamento. O endpoint de uso deixa esse estado visível, mas não há reconciliação automática. Não há streaming, cache de texto, fila ou interface gráfica.

As chaves do exemplo são públicas e apenas para uso local. A URL do provedor vem da configuração do operador, nunca do corpo enviado pelo cliente.

## Docker

```powershell
docker build -t inference-gateway .
docker run --rm -p 127.0.0.1:8006:8006 --env-file .env -e HOST=0.0.0.0 -v gateway-data:/app/var inference-gateway
```

Se Ollama estiver no host, ajuste `baseUrl` para um endereço acessível pelo contêiner.

Veja [docs/architecture.md](docs/architecture.md) e [COMMITS.txt](COMMITS.txt).
