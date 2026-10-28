# Pool: desenho da v1

Projeto novo, separado de qualquer outro. O nome é provisório: a pasta se chama `dex` e o programa `dex`.

**Estado (2026-10-22): na devnet** em `CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK`.
- A autoridade de upgrade é a carteira de devnet `7f2Mi…hPAA`. A chave do endereço do programa está no WSL em `~/dex-target/pool/deploy/`.
- Não está na mainnet. A mainnet vai ter carteira própria, com a autoridade de upgrade numa multisig.
- `../examples/devnet.mjs` lançou a moeda de teste `5uZ9tNmDM8pTaCtXQDeb4mAJ6g8m6pxFANpFEtv7ozJS` (o nome saiu errado, "DESKTOP-DN2LL2B": o script lia a variável NAME, que no WSL é o nome do computador; agora usa COIN_NAME), com a primeira compra na mesma transação, uma venda e outra compra. O registro está em `../examples/devnet.json`.

## Em uma frase

Um único programa em que a curva de lançamento **é** o pool. Quando a moeda gradua, a liquidez virtual sai, uma parte fixa dos tokens é queimada e o mesmo pool segue negociando como uma AMM comum. Não há migração, nem outro endereço, nem token de LP.

## Vida de uma moeda

1. **Lançamento**, uma instrução só (`launch`). O programa:
   - cria o mint Token-2022 com os metadados;
   - cunha 1 bilhão de tokens para o cofre do pool;
   - tira todas as autoridades.

   A primeira compra do criador pode ir na mesma transação. Ou o lançamento abre um **lote de abertura** (abaixo), e aí ninguém compra antes do lote fechar.
2. **Curva**: produto constante com SOL virtual. Enquanto dura a curva, o preço nunca fica abaixo do de abertura.
3. **Graduação**: acontece dentro da compra que alcança o limite.
   - A curva só aceita SOL até o limite exato. O resto da mesma compra passa pela AMM já graduada.
   - O SOL virtual sai, e a queima é sempre a mesma, conhecida desde o lançamento.
   - O preço não dá salto, e a liquidez fica travada para sempre.
4. **Depois**: o mesmo pool, as mesmas instruções.

**Lote de abertura** (opcional, 2026-10-28): quem lança escolhe uma janela de 2 a 15 minutos (`opening_secs`; 0 é sem lote).
- Durante a janela, `buy` é recusado (`NotOpenYet`). O SOL vai para **assentos**, um por carteira (`commit`), até o último minuto; o saque (`withdraw`) fica aberto até o fim da janela. O criador pega o assento dele na própria transação do lançamento, no lugar da primeira compra.
- No último minuto (`OPENING_LOCK_SECS`) não entra SOL novo (`OpeningLocked`), mas ainda dá para sair. Assim todo assento vê o total final por um minuto e pode ir embora. A ordem era a inversa: dava para uma baleia entrar no último segundo, com os assentos antigos já travados, e fazer `settle`, `claim_seat` e `sell` numa transação só, vendendo primeiro com o SOL dos assentos pequenos.
- Quem tira todo o SOL fecha o assento e recebe o aluguel de volta; um `commit` depois, antes do último minuto (até na mesma transação), abre outro.
- Depois da janela, **qualquer um** chama `settle`: uma compra só com todo o SOL do lote. Todo assento paga o mesmo preço, o do criador também. Se o lote passar da linha, a moeda gradua ali mesmo.
- Cada assento faz `claim_seat` e recebe `floor(tokens do lote × SOL do assento / SOL do lote)`. A poeira do arredondamento fica no cofre, fora da reserva. O assento fecha e devolve o aluguel.
- Logo depois do `settle` o preço à vista fica acima do preço médio do lote sem a taxa, então quem vende primeiro leva mais: é a corrida da saída, inerente ao preço único. (Com a taxa, só fica acima num lote maior que cerca de 0,3 SOL, com 30 SOL virtuais e 1%.)
- Um lote abaixo de 0,01 SOL (`MIN_BATCH`), ou que a matemática recusa, não compra nada: a moeda abre como estava e cada assento pega o SOL de volta.
- Vender nunca é bloqueado; antes do settle só não há o que vender.

**Hooks:** as moedas saem sem transfer hook nesta versão, por decisão do usuário. O caminho das negociações já repassa as contas de um hook, e o pool guarda o campo `hook_program` (hoje vazio). Uma versão futura pode trazer um hook próprio do projeto sem reescrever as negociações.

## Números da curva (decididos pelo usuário)

Supply de 1.000.000.000 com 6 decimais. A curva abre com 30 SOL de market cap e gradua com 420 SOL (14×).

- SOL virtual = 30 SOL.
- A moeda gradua quando o pool tem **82,25 SOL reais**, já sem as taxas; os compradores pagam cerca de 83,08 SOL com 1% de taxa. Nesse momento foram vendidos 732,7 M de tokens.
- Na graduação são queimados **71,43 M de tokens (7,14%)**. O pool fica com 82,25 SOL e 195,8 M de tokens, no mesmo preço.
- Depois da queima, o supply circulante é 928,6 M. Sites que usam o supply atual mostram **390 SOL** de market cap na graduação.
- **Depois da graduação o preço pode cair abaixo do de abertura** (até cerca de 0,62× se todos venderem). Cerca de 17 SOL ficam no pool para sempre.
- Para o código:
  - limite gravado no lançamento: `R_g = ceil_isqrt(M_g·V) − V`;
  - queima: `B = floor(T·V/x)`;
  - compra: `T_novo = ceil(k/(x+dx))`;
  - venda: `x_novo = ceil(k/(T+dt))`;
  - taxa: `ceil(valor·bps/10.000)`;
  - todas as contas em u128.

  `reference/` tem a mesma matemática em JavaScript com testes de propriedade.

## Taxas

- **1% por negociação, em SOL**: na compra, sai do SOL que entra; na venda, do SOL que sai. Metade vai para o criador e metade para a tesouraria. Sem anti-sniper.
- **Tetos fixos no programa**:
  - taxa no máximo 3%;
  - SOL virtual entre 1 e 1.000 SOL;
  - graduação entre 2× e 100× a abertura;
  - taxa de lançamento no máximo 1 SOL.
- Os parâmetros ficam gravados no pool no lançamento e nunca mudam.
- **Saque das taxas**: o criador saca a parte dele com `claim_creator_fees`. Qualquer pessoa chama `claim_treasury_fees`, que sempre paga a tesouraria gravada naquele pool.
- **Launchpad depois**: curva e taxa já são escolhas de cada lançamento, dentro dos tetos. Assim o launchpad pode dar mais liberdade aos criadores sem mudar o programa.

## Contas

- **`Config` em `["config"]`**:
  - admin, `launcher` e tesouraria para moedas novas;
  - taxa de lançamento, taxa mínima e a parte da tesouraria em cada taxa;
  - `launches_open`.

  Só a autoridade de upgrade cria a config. A tesouraria tem que ser uma carteira comum com o próprio aluguel.
- **`Pool` em `["pool", mint]`**, zero-copy:
  - mint, criador e a tesouraria gravada no lançamento;
  - o cofre e `hook_program` (vazio);
  - as reservas **anotadas** (`virtual_sol`, `real_sol`, `token_reserve`), nunca lidas dos saldos;
  - limite de graduação, queima, taxas devidas e pagas, volume, datas, taxa, parte da tesouraria;
  - o lote de abertura, nos 64 bytes que eram reservados (`opens_at`, `opening_sol`, `opening_total_sol`, `opening_tokens`, `opening_tokens_left`, `opening_seats`, `opening_state`). Um pool antigo lê zeros: sem lote. Sobram 16 bytes reservados; o tamanho continua 8 + 336.
- **`Seat` em `["seat", pool, dono]`**: dono, pool e o SOL do assento. Fecha no `claim_seat` ou no saque de tudo; um `commit` depois abre outro.
- **SOL**: fica no próprio `Pool`, acima do aluguel. Invariante: `lamports = aluguel + real_sol + taxas devidas + opening_sol`.
- **Cofre**: a ATA do `Pool` para o mint. Guarda `token_reserve + opening_tokens_left`.
- **Mint em `["mint", criador, salt]`** (salt: um u64 que quem lança escolhe, ao acaso no site): o endereço da moeda é do próprio programa, então só o programa cria uma conta ali, e ninguém pode ter criado nada nele antes. As moedas lançadas antes disso (devnet) têm mints comuns e continuam funcionando, porque a pool sai do mint.

## Instruções

| Instrução | Quem chama | O que faz |
|---|---|---|
| `init_config` | autoridade de upgrade, uma vez | cria a config |
| `update_config` | admin | muda a config, só para moedas **novas** |
| `launch` | admin ou `launcher` (todos, quando `launches_open`) | cria a moeda e o pool |
| `buy(sol_in, min_tokens_out)` | qualquer um | compra; gradua no limite |
| `sell(tokens_in, min_sol_out)` | qualquer um | vende |
| `claim_creator_fees` / `claim_treasury_fees` | criador / qualquer um | saca taxas |
| `set_creator` | criador | passa os direitos; paga ao criador antigo o que já era dele |
| `commit(sol)` / `withdraw(sol)` | qualquer um / o dono do assento | põe SOL no assento do lote, até o último minuto / tira, até o fim da janela |
| `settle` | qualquer um, depois da janela | uma compra só com todo o SOL do lote, ou o reembolso |
| `claim_seat` | o dono do assento | a parte dele nos tokens do lote, ou o SOL de volta |

Não existe instrução que tire dinheiro de um pool para o admin, nem pausa de vendas. Os erros são numerados a partir de 7000. Eventos: `Launched` (com `opens_at`), `TradeEvent` (com `recipient` e `by_creator`), `Graduated`, `FeesClaimed`, `CreatorChanged`, `ConfigUpdated`, e os do lote: `Committed`, `Withdrawn`, `Settled`, `SeatClaimed`. A compra do lote sai como um `TradeEvent` com o próprio pool como trader.

## Como chamar (para o site)

`../examples/devnet.mjs` monta todas as instruções à mão e serve de referência.

- **`buy` e `sell`**: trader (assina, gravável), pool (gravável), mint (**gravável**, por causa da queima da graduação), cofre (gravável), conta de token do trader (gravável), Token-2022, System. Na compra, criar antes a ATA do comprador na mesma transação.
- **`launch`**: 9 contas; só quem lança assina (o mint é a PDA `["mint", criador, salt]`, com o salt e depois `opening_secs` (u32) no fim dos argumentos).
- **Lote**: `commit`: dono (assina, gravável), pool (gravável), assento (gravável), System. `withdraw`: dono, pool, assento. `settle`: pool, mint e cofre (graváveis), Token-2022. `claim_seat`: dono, pool, assento, mint, cofre, conta de token do dono (graváveis, menos o mint), Token-2022; criar antes a ATA na mesma transação.
- **Compute medido** (13 rodadas do teste `compute_units`, 2026-10-28):

  | Operação | Compute |
  |---|---|
  | lançamento | 79 mil a 98 mil |
  | lançamento com o `commit` do criador | 94 mil a 117 mil |
  | primeira compra (com criação da conta) | 32 mil a 37 mil |
  | compra | 19 mil a 24 mil |
  | venda | 12 mil |
  | compra que gradua | 25 mil a 30 mil |
  | `commit` num assento novo / num que já existe | 15 mil a 22 mil / 11 mil a 18 mil |
  | `withdraw` | 8 mil |
  | `settle` sem / com graduação | 7 mil / 13 mil |
  | `claim_seat` (com criação da conta) | 32 mil a 35 mil |

  Os números mudam de rodada para rodada: as chaves dos testes são novas a cada vez, e cada tentativa a mais na busca do bump de uma PDA custa 1,5 mil. O teste confere contra os limites que o site pede: 200 mil para o lançamento (com compra ou `commit`), 60 mil para a compra, 40 mil para a venda, 50 mil para o `commit`, 20 mil para o `withdraw`, 60 mil para o `settle` e 80 mil para o `claim_seat` (a conta de token aberta junto também busca um bump; numa rodada chegou a 46 mil). O mais justo é o `commit`: com 15 mil de base, os 50 mil cobrem 23 tentativas a mais na busca do bump do assento (com 30 mil, cerca de 1 par moeda e carteira em 2 mil falharia sempre).

## Segurança sem auditoria (por enquanto)

1. **Anchor 1.2**, com `seeds`, `has_one` e `address` em toda conta.
2. **Reservas anotadas**: doação direta não muda o preço.
3. **Matemática em u128, arredondando a favor do pool, com `min_out` obrigatório.**
4. **Sem token de LP.**
5. **O admin não alcança o dinheiro dos pools**; a tesouraria de cada pool é fixa; as vendas não pausam.
6. **Mint fechado**: só os metadados, nenhuma autoridade, conferido depois de criar.
7. **Tetos fixos** para taxas e curva.
8. **O mint é uma PDA do programa** (2026-10-28), o que fecha na raiz o ataque das contas "intransferíveis": antes, quem tinha a chave de um endereço podia criar ali um mint com extensões, abrir contas para outras carteiras, fechar o mint e lançar a moeda no mesmo endereço, e as contas antigas ficavam com a marca. Agora não há chave: o lançamento num endereço que não é o do programa é recusado. A defesa antiga continua: **o pool só paga em contas limpas** (recusa contas congeladas ou com extensões herdadas).
9. **Multisig com timelock** para a autoridade de upgrade, antes da mainnet.
10. **Começo controlado**: só a equipe lança.

Testes:
- 9 de matemática em `src/math.rs`;
- 21 de integração em LiteSVM com o Token-2022 de verdade (`../pool-tests`), entre eles o ataque das contas "intransferíveis" (agora recusado no lançamento), o endereço que pertence ao criador e ao salt, e o lote de abertura (um preço para todos os assentos, a ordem das janelas, o saque total que fecha o assento e o `commit` que o abre de novo, o reembolso, o lote que gradua, os limites da janela, a janela mínima com o `commit` do criador no lançamento, o compute de cada passo);
- na devnet, `site/chain/batch-check.mjs` faz um lote de verdade pelo pacote do site;
- `../test.sh` roda tudo.

O binário tem 479 KB, cerca de 3,4 SOL de aluguel.

## Revisões (2026-10-22)

- **Desenho:** um revisor tentou quebrar, outro conferiu as ferramentas, um terceiro refez a matemática. Acharam o `init_config` aberto, a falta de tetos e a graduação que comprava tudo com liquidez virtual. Tudo corrigido.
- **Código:** dois revisores. Acharam as contas "intransferíveis" deixadas por um mint anterior, as taxas que mudavam de dono na troca de criador, a tesouraria sem validação, um tamanho de metadados que travava o lançamento, os códigos de erro e a falta de eventos. Tudo corrigido e coberto por testes.

## Fora da v1

Hooks, Jupiter e OKX (exigem SDK), LP de terceiros, pares além do SOL, taxa de transferência e auditoria.

## Etapas

1. ~~Programa e testes locais.~~
2. ~~Devnet.~~
3. **Site próprio**, em andamento.
4. **Mainnet**: carteira nova, multisig, deploy (cerca de 3,4 SOL de aluguel) e o token principal do projeto lançado na DBC normal, decisão do usuário.

## Em aberto

- Nome e marca.
- Se a graduação sobe para 450 SOL, para os sites mostrarem 420 depois da queima.
