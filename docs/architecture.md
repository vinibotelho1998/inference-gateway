# Fluxo e compromissos

Autenticacao -> validacao -> rate limit -> limite de concorrencia -> reserva diaria no SQLite -> provedores em ordem -> contabilizacao -> resposta.

A reserva usa BEGIN IMMEDIATE, consulta o contador e insere a chamada na mesma transacao. Nao ha corrida entre verificar saldo e reservar dentro de um banco SQLite. Uma falha no provedor consome o orcamento de requisicoes porque ja utilizou a infraestrutura. Rejeicoes por concorrencia nao sao reservadas. O contador e em dias UTC, independentemente do fuso da maquina.

O circuit breaker usa estado fechado, aberto e uma unica sonda em half-open. Um provedor aberto e pulado no fallback. Nao ha retry adicional no mesmo provedor: isso evita multiplicar tentativas de geracao e recursos consumidos.

Erros de contabilizacao nao sao tratados como falhas do modelo para disparar outra inferencia. O gateway nao persiste prompt ou resposta. O registro contem apenas cliente, dia, estado, quantidade de caracteres/tokens, latencia e provedor. Logo nao oferece replay nem idempotencia da geracao: um retry do cliente e uma nova chamada e conta no orcamento.

SQLite tem WAL e pode ser inspecionado com ferramentas comuns. Em maior escala, seriam necessarios um banco central, rate limit distribuido, metricas por tentativa, reconciliacao de chamadas interrompidas e autenticacao com rotacao de segredos. Esses pontos sao evolucoes documentadas, nao capacidades ja implementadas.
