# Validação do gateway com inferência real

`npm run verify:ollama` exige um servidor Ollama com o modelo já baixado e uma instância HTTP deste gateway configurada somente com provedores `ollama`. O script não aceita o adaptador `demo` como evidência de funcionamento da IA e não baixa modelos ou inicia containers.

## Modelo de referência

[Qwen2.5 1.5B](https://ollama.com/library/qwen2.5:1.5b) é a configuração de referência: aproximadamente 986 MB no formato publicado, com geração multilíngue. O arquivo do modelo é apenas parte da memória usada pelo runtime. [Qwen2.5 0.5B](https://ollama.com/library/qwen2.5:0.5b) é uma opção menor, com aproximadamente 398 MB. Ambos trabalham com o endpoint [`POST /api/generate`](https://docs.ollama.com/api/generate) usado pelo adaptador.

No servidor, configure `PROVIDERS_JSON` com `kind=ollama`, o endereço acessível a partir do processo/container e o modelo real. Para CPU e primeiro carregamento, use `PROVIDER_TIMEOUT_MS=120000`; o timeout de três segundos do exemplo de demonstração pode ser insuficiente. A API devolve as contagens reais de tokens fornecidas pelo Ollama, sem transformá-las em uma estimativa de custo financeiro.

```powershell
$env:GATEWAY_URL = 'http://127.0.0.1:8006'
$env:GATEWAY_API_KEY = 'demo-client-a'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
$env:GENERATION_MODEL = 'qwen2.5:1.5b'
npm.cmd run verify:ollama
```

Essas variáveis configuram o cliente de validação; o script não carrega `.env` automaticamente nem altera a configuração da instância em execução.

## Duas etapas complementares

Primeiro, o script inspeciona o modelo no Ollama e chama a instância indicada por `GATEWAY_URL`. Ele verifica `kind=ollama`, modelo esperado, texto não vazio, tokens de entrada/saída e incremento da contabilização persistente. Essa etapa testa o gateway efetivamente iniciado, inclusive quando está em container.

Depois, inicia uma API HTTP efêmera em uma porta local escolhida pelo sistema, usando exatamente as classes e adaptadores de produção do projeto. O primário aponta para uma porta real cujo listener acabou de ser fechado; o backup aponta para o Ollama real:

```text
requisição HTTP
  -> primário Ollama inacessível: conexão falha
  -> backup Ollama: modelo gera a resposta
  -> circuito do primário fica aberto
  -> segunda requisição pula o primário e usa o backup real
```

Não há adapter de inferência mockado nessa segunda etapa. O banco de contabilização dessa instância isolada é temporário e fica em memória; a primeira etapa usa o banco da instância já iniciada. O script verifica os provedores tentados, `fallbackUsed`, estado do circuito e contabilização de exatamente duas respostas na instância isolada. Ao terminar, fecha o servidor e o banco temporários. A configuração do gateway já em execução permanece intacta.

O relatório fica em `var/ollama-integration.json`; altere com `INTEGRATION_REPORT`. Ele registra versão, capacidades, respostas reais, tokens, latências, provedores tentados e circuitos. `INTEGRATION_TIMEOUT_MS` altera o prazo do teste. Uma falha termina o processo com código 1 e mantém os detalhes no relatório.

O registro da execução com Ollama 0.40.11 e Qwen2.5 1.5B está em [`reports/ollama-integration.json`](../reports/ollama-integration.json). A chamada ao gateway em execução informou contagens reais de tokens. Na etapa isolada, a primeira chamada tentou o primário indisponível e o backup; a seguinte tentou apenas o backup, com o circuito do primário aberto. As duas respostas foram contabilizadas. Esse registro usa somente perguntas fictícias de validação.

O resultado comprova integração e failover em uma indisponibilidade controlada. Não é um teste de carga, de qualidade geral do modelo nem de recuperação de uma infraestrutura distribuída. Para testar o mesmo cenário inteiramente entre containers, configure um segundo serviço de gateway com primário inacessível e backup Ollama e rode as mesmas chamadas HTTP contra ele.
