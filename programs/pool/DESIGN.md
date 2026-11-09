# Pool: desenho da v1

Projeto novo, separado de qualquer outro. O nome é provisório: a pasta se chama `dex` e o programa `dex`.

**Estado (2026-10-22): na devnet** em `CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK`.
- A autoridade de upgrade é a carteira de devnet `7f2Mi…hPAA`. A chave do endereço do programa está no WSL em `~/dex-target/pool/deploy/`.
- Não está na mainnet. A mainnet vai ter carteira própria, com a autoridade de upgrade numa multisig.
- **Curva única, 20% da taxa no pool e a linha no market cap (2026-11-09)**: no código e nos testes, ainda não na devnet. O programa no ar é o de 671ae17 (o mesmo desde o lote de abertura): o build desse commit dá os mesmos bytes que estão em `CbAjrr…` (sha256 `a983888e…`, 490.736 bytes). As 19 pools da devnet estão todas abaixo da linha; nenhuma graduou pela queima.
- `../examples/devnet.mjs` lançou a moeda de teste `5uZ9tNmDM8pTaCtXQDeb4mAJ6g8m6pxFANpFEtv7ozJS` (o nome saiu errado, "DESKTOP-DN2LL2B": o script lia a variável NAME, que no WSL é o nome do computador; agora usa COIN_NAME), com a primeira compra na mesma transação, uma venda e outra compra. O registro está em `../examples/devnet.json`.

## Em uma frase

Um único programa em que a curva de lançamento **é** o pool, a vida toda: um produto constante sobre o SOL virtual mais o SOL real, do lançamento em diante. O SOL virtual nunca sai e nada é queimado; 20% de cada taxa fica no pool. Não há migração, nem outro endereço, nem degrau de profundidade, nem token de LP.

## Vida de uma moeda

1. **Lançamento**, uma instrução só (`launch`). O programa:
   - cria o mint Token-2022 com os metadados;
   - cunha 1 bilhão de tokens para o cofre do pool;
   - tira todas as autoridades.

   A primeira compra do criador pode ir na mesma transação. Ou o lançamento abre um **lote de abertura** (abaixo), e aí ninguém compra antes do lote fechar.
2. **Curva**: produto constante sobre `virtual_sol + real_sol` e `token_reserve`. Toda compra e toda venda é uma perna só dessa curva, antes e depois da linha. O SOL virtual nunca sai, então o preço nunca fica abaixo do de abertura, a vida toda.
3. **Graduação**: um marco ao vivo, não um degrau.
   - A linha é o market cap no supply inteiro escolhido no lançamento (`graduation_mcap`). A moeda está graduada (`graduated` = 1) enquanto `(virtual_sol + real_sol) × SUPPLY ≥ graduation_mcap × token_reserve`, a conta exata em u128, sem divisão (`Reserves::over_the_line` em `math.rs`), e deixa de estar quando as vendas levam o market cap para baixo. Cada compra, venda e `settle` recalcula.
   - Cabe em u128: `virtual + real` < 2^65 e `SUPPLY` < 2^50; `graduation_mcap` e `token_reserve` são u64. Nada é queimado numa pool nova, então o supply inteiro é o que existe.
   - Só uma compra ou um `settle` sobem a moeda para a linha. A venda nunca: a parte da taxa que fica no pool sai do bruto que a curva pagou, então o SOL da curva termina no máximo onde estava e o `token_reserve` cresce; o preço não sobe.
   - Nada acontece com as reservas ou com o preço na linha: a compra que cruza é a mesma que seria com a linha em qualquer outro lugar.
   - O evento `Graduated` sai a cada vez que o market cap cruza a linha para cima (de 0 para 1), com as reservas de depois e `burned` = 0. `graduated_at` guarda a primeira vez e nunca volta a 0: é só história.
   - `graduation_sol` continua gravado no lançamento (`√(M·V) − V`, arredondado para cima), mas é só informação: o SOL real que leva uma pool recém-lançada até a linha.
   - Todo SOL real pode sair por vendas; o que fica é o SOL virtual, que só existe no preço.
4. **Depois**: a mesma curva, as mesmas instruções.

**Lote de abertura** (opcional, 2026-10-28): quem lança escolhe uma janela de 2 a 15 minutos (`opening_secs`; 0 é sem lote).
- Durante a janela, `buy` é recusado (`NotOpenYet`). O SOL vai para **assentos**, um por carteira (`commit`), até o último minuto; o saque (`withdraw`) fica aberto até o fim da janela. O criador pega o assento dele na própria transação do lançamento, no lugar da primeira compra.
- No último minuto (`OPENING_LOCK_SECS`) não entra SOL novo (`OpeningLocked`), mas ainda dá para sair. Assim todo assento vê o total final por um minuto e pode ir embora. A ordem era a inversa: dava para uma baleia entrar no último segundo, com os assentos antigos já travados, e fazer `settle`, `claim_seat` e `sell` numa transação só, vendendo primeiro com o SOL dos assentos pequenos.
- Quem tira todo o SOL fecha o assento e recebe o aluguel de volta; um `commit` depois, antes do último minuto (até na mesma transação), abre outro.
- Depois da janela, **qualquer um** chama `settle`: uma compra comum na curva com todo o SOL do lote, com a taxa e a parte do pool. Todo assento paga o mesmo preço, o do criador também. Se o lote passar da linha, a moeda fica graduada ali mesmo, e `Graduated` sai antes de `Settled` (a ordem que `site/chain/check-opening.mjs` espera).
- Cada assento faz `claim_seat` e recebe `floor(tokens do lote × SOL do assento / SOL do lote)`. A poeira do arredondamento fica no cofre, fora da reserva. O assento fecha e devolve o aluguel.
- Logo depois do `settle` o preço à vista fica acima do preço médio do lote sem a taxa, então quem vende primeiro leva mais: é a corrida da saída, inerente ao preço único. (Com a taxa, só fica acima num lote maior que cerca de 0,3 SOL, com 30 SOL virtuais e 1%.)
- Um lote abaixo de 0,01 SOL (`MIN_BATCH`), ou que a matemática recusa, não compra nada: a moeda abre como estava e cada assento pega o SOL de volta.
- Vender nunca é bloqueado; antes do settle só não há o que vender.

**Hooks:** as moedas saem sem transfer hook nesta versão, por decisão do usuário. O caminho das negociações já repassa as contas de um hook, e o pool guarda o campo `hook_program` (hoje vazio). Uma versão futura pode trazer um hook próprio do projeto sem reescrever as negociações.

## Números da curva (decididos pelo usuário)

Supply de 1.000.000.000 com 6 decimais. A curva abre com 30 SOL de market cap e gradua com 420 SOL (14×).

- SOL virtual = 30 SOL.
- A moeda gradua quando o market cap no supply inteiro chega a **420 SOL**, sempre. Numa moeda recém-lançada isso acontece com **82,25 SOL reais** (`graduation_sol`), sem taxa. Nesse momento foram vendidos 732,7 M de tokens e o pool tem 267,3 M. Numa compra só, com 1% de taxa e 20% dela no pool, a linha custa 82,997 SOL e deixa 82,33 SOL reais: a parte do pool já subiu `k` no caminho.
- Na linha, o SOL efetivo é 112,25 SOL (30 virtuais + 82,25 reais), o preço é **0,42 SOL por milhão de tokens** e o market cap é **420 SOL** no supply inteiro, que é o supply que existe: nada é queimado.
- Uma compra de exatamente `graduation_sol`, sem taxa, numa pool recém-lançada leva o market cap à linha (30 e 420) ou o deixa um fio abaixo, porque o `token_reserve` que sobra é arredondado para cima: com 10 virtuais e linha em 90, os 20 SOL deixam 89,99999999999982 SOL de market cap, e um lamport a mais gradua. Quando a conta fecha sem arredondar, a compra cai na linha exata, e a linha conta como graduada: com 10 virtuais e linha em 40, os 10 SOL deixam metade do supply no pool, `x·S = M·T`. Um lamport a menos fica sempre abaixo. Com a taxa, a mesma compra fica abaixo (414,48 SOL com 1%). Os testes conferem o predicado do market cap, nunca a igualdade com `graduation_sol`.
- **A parte do pool não antecipa a graduação.** Ela entra no SOL real sem tirar tokens, então `k` cresce, e no mesmo SOL real o preço (`x²/k`) fica menor. Como a linha é o market cap, a moeda só precisa de mais SOL real para chegar aos 420. Com 1% de taxa, 10 SOL de quem segura e idas e voltas de 10 SOL: 106,00 SOL reais na linha depois de cerca de 10 mil SOL de volume, 160,54 depois de cerca de 40 mil, 240,36 depois de cerca de 100 mil; com 3%, 143,97 depois de cerca de 10 mil (e cerca de 2.260 idas e voltas a levam até lá sozinhas, com 287,42 reais). As moedas lançadas antes (parte do pool 0) chegam com 82,67. Medida pelo SOL real, como até esta mudança, a linha chegava com market cap de 419,6 SOL depois de 83 SOL de volume, 385,8 depois de 2.070, 290,2 depois de 10.017 e 149,3 depois de 38.581. `reference/numbers.js` imprime a tabela de hoje (onde a linha é cruzada depois de 0, 500, 2.000 e 5.000 idas e voltas); os números da linha antiga ficam num comentário dele.
- O site mede o caminho como o programa: a barra é `(x − V) ÷ (x_na_linha − V)`, com `x_na_linha = √(M·k/S)` (`lineSol` em `site/chain/src/index.mjs` e `assets/pool-math.js`), que é `real_sol ÷ graduation_sol` numa pool sem taxa guardada. A linha do gráfico é o market cap escolhido no lançamento.
- Uma compra de 10 SOL na linha move o preço **+18,6%** (na versão com queima, com o pool só de SOL real, eram +25,8%).
- Se todos venderem, os vendedores recebem os 82,25 SOL reais (81,43 com 1% de taxa) e o preço volta ao de abertura, ou fica um pouco acima dele, pelo que o pool guardou das taxas (com 1%, ficam 0,16 SOL no pool e o preço fica 0,5% acima). O preço nunca fica abaixo do de abertura.
- Para o código:
  - gravado no lançamento, só para leitura: `R_g = ceil_isqrt(M_g·V) − V`;
  - taxa: `fee = ceil(valor·bps/10.000)`; parte do pool: `to_pool = floor(fee·pool_share_bps/10.000)`, com `pool_share_bps` limitado a 10.000;
  - compra: `rest = sol_in − fee`, `T_novo = ceil(k/(V+R+rest))`, depois `R_novo = R + rest + to_pool`;
  - venda: `x_novo = max(ceil(k/(T+dt)), V)`, `bruto = V + R − x_novo`, o vendedor recebe `bruto − fee`, `R_novo = (x_novo − V) + to_pool` (soma saturada: a venda nunca falha por conta, só a poeira é recusada);
  - `graduated = (V + R_novo) × S ≥ M_g × T_novo` depois de cada uma, em u128 (numa pool da primeira versão, `M_g` lido como 0: graduada para sempre);
  - todas as contas em u128. Valem sempre: `k` nunca cai e `token_reserve` nunca passa do supply.

  `reference/` tem a mesma matemática em JavaScript com testes de propriedade (e uma cópia da matemática da primeira versão, para as pools que ela graduou); é a mesma matemática de `site/chain/src/index.mjs`, que `site/chain/check-math-rs.mjs` confere inteiro por inteiro contra `src/math.rs` (nenhum script compara `reference/` com `src/math.rs` direto). `reference/numbers.js` imprime os números acima.

## Taxas

- **1% por negociação, em SOL**: na compra, sai do SOL que entra; na venda, do SOL que sai. Sem anti-sniper.
- **20% de cada taxa fica no pool** (`POOL_SHARE_BPS` = 2.000 em `state.rs`, gravado em cada pool nova no lançamento, no campo `pool_share_bps`). A parte do pool sai primeiro e entra no SOL real; o resto (`fee − to_pool`) vai para `Pool::owe`, que divide pela `treasury_share_bps` gravada no pool. Com a config de hoje (50%): **40% criador, 40% tesouraria, 20% pool**.
  - Na compra, a perna da curva usa o SOL sem a taxa inteira; a parte do pool entra depois, então nenhum token sai por ela. Na venda, a parte do pool não sai do pool.
  - A parte do pool aumenta `k`: o preço sobe um pouco a cada negociação. Ela não fica presa: as vendas seguintes levam parte dela pelo preço. Ela não antecipa a graduação: a linha é o market cap, e depois de volume a moeda precisa de mais SOL real para chegar aos mesmos 420 (acima, em "Números da curva").
  - **Para tirar os 20% só da tesouraria** (50% criador, 30% tesouraria, 20% pool): basta pôr `treasury_share_bps` = 3.750 na config, sem mudar código. Vale para as moedas lançadas depois da mudança; um teste (`a_fifth_of_every_fee_stays_in_the_pool`) confere essa conta.
  - Nos livros, `owe` recebe `fee − to_pool` nos três lugares (`buy`, `sell`, `settle`). Contar a taxa duas vezes faria `check_solvent` recusar toda venda.
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
  - a linha de graduação (`graduation_mcap`) e o SOL real que leva a pool recém-lançada até ela (`graduation_sol`, só leitura), taxas devidas e pagas, volume, datas, taxa, parte da tesouraria;
  - `burned`: o que a primeira versão queimou ao graduar; 0 em toda moeda desde então (é a marca da regra de legado, abaixo);
  - `graduated` (ao vivo) e `graduated_at` (a primeira vez na linha);
  - o lote de abertura, nos 64 bytes que eram reservados (`opens_at`, `opening_sol`, `opening_total_sol`, `opening_tokens`, `opening_tokens_left`, `opening_seats`, `opening_state`). Um pool antigo lê zeros: sem lote;
  - `pool_share_bps` (u16), nos bytes que eram enchimento depois de `opening_state`: `_pad2` virou um byte só, e o campo fica no byte 326 da conta (o de `_pad2` + 1, alinhado em 2). Um pool antigo lê 0. Sobram 16 bytes reservados; o tamanho continua 8 + 336 (um teste em `state.rs` confere as posições).
- **`Seat` em `["seat", pool, dono]`**: dono, pool e o SOL do assento. Fecha no `claim_seat` ou no saque de tudo; um `commit` depois abre outro.
- **SOL**: fica no próprio `Pool`, acima do aluguel. Invariante: `lamports = aluguel + real_sol + taxas devidas + opening_sol`.
- **Cofre**: a ATA do `Pool` para o mint. Guarda `token_reserve + opening_tokens_left`.
- **Pools da primeira versão (regra de legado, obrigatória)**: uma pool com `burned` > 0 graduou do jeito antigo: perdeu o SOL virtual na linha e queimou tokens. `Pool::reserves()` a lê como a primeira versão a deixou: `virtual_sol` = 0 para a matemática (o campo continua guardando 30, para exibição), `graduation_mcap` 0 (graduada para sempre, mesmo vendida até o fim, com o market cap muito abaixo da linha que um dia cruzou) e `pool_share_bps` 0 (a taxa inteira para criador e tesouraria). Assim ela negocia com os mesmos inteiros de antes, como um x·y=k só de SOL real. Sem essa regra, o preço saltaria 36,5% e as últimas vendas pediriam SOL que não existe. As pools antigas que ainda não graduaram (`burned` = 0) seguem a curva única ao cruzar a linha, com `pool_share_bps` 0 (lido como zero do espaço antes vazio). Abaixo da linha de SOL real da primeira versão elas estão também abaixo da do market cap (`k` nunca fica abaixo de `V·S`), então até lá negociam igual nos dois binários. Hoje nenhuma pool da devnet graduou; a regra vale para qualquer uma que gradue antes do upgrade.
- **Mint em `["mint", criador, salt]`** (salt: um u64 que quem lança escolhe, ao acaso no site): o endereço da moeda é do próprio programa, então só o programa cria uma conta ali, e ninguém pode ter criado nada nele antes. As moedas lançadas antes disso (devnet) têm mints comuns e continuam funcionando, porque a pool sai do mint.

## Instruções

| Instrução | Quem chama | O que faz |
|---|---|---|
| `init_config` | autoridade de upgrade, uma vez | cria a config |
| `update_config` | admin | muda a config, só para moedas **novas** |
| `launch` | admin ou `launcher` (todos, quando `launches_open`) | cria a moeda e o pool |
| `buy(sol_in, min_tokens_out)` | qualquer um | compra; liga `graduated` ao chegar à linha |
| `sell(tokens_in, min_sol_out)` | qualquer um | vende |
| `claim_creator_fees` / `claim_treasury_fees` | criador / qualquer um | saca taxas |
| `set_creator` | criador | passa os direitos; paga ao criador antigo o que já era dele |
| `commit(sol)` / `withdraw(sol)` | qualquer um / o dono do assento | põe SOL no assento do lote, até o último minuto / tira, até o fim da janela |
| `settle` | qualquer um, depois da janela | uma compra comum com todo o SOL do lote, ou o reembolso |
| `claim_seat` | o dono do assento | a parte dele nos tokens do lote, ou o SOL de volta |

Não existe instrução que tire dinheiro de um pool para o admin, nem pausa de vendas. Os erros são numerados a partir de 7000. Eventos: `Launched` (com `opens_at`), `TradeEvent` (com `recipient`, `by_creator` e, no fim, `pool_fee`: a parte da taxa que ficou no pool; 155 bytes, eram 147, e o site lê o campo só se houver bytes a mais), `Graduated` (a cada subida pela linha; mesmo formato, `burned` = 0), `FeesClaimed`, `CreatorChanged`, `ConfigUpdated`, e os do lote: `Committed`, `Withdrawn`, `Settled`, `SeatClaimed`. A compra do lote sai como um `TradeEvent` com o próprio pool como trader.

## Como chamar (para o site)

`../examples/devnet.mjs` monta todas as instruções à mão e serve de referência.

- **`buy` e `sell`**: trader (assina, gravável), pool (gravável), mint (**gravável**: a primeira versão queimava ali; nada escreve nele agora, mas o programa continua pedindo, para a lista de contas não mudar), cofre (gravável), conta de token do trader (gravável), Token-2022, System. Na compra, criar antes a ATA do comprador na mesma transação.
- **`launch`**: 9 contas; só quem lança assina (o mint é a PDA `["mint", criador, salt]`, com o salt e depois `opening_secs` (u32) no fim dos argumentos).
- **Lote**: `commit`: dono (assina, gravável), pool (gravável), assento (gravável), System. `withdraw`: dono, pool, assento. `settle`: pool, mint e cofre (graváveis), Token-2022. `claim_seat`: dono, pool, assento, mint, cofre, conta de token do dono (graváveis, menos o mint), Token-2022; criar antes a ATA na mesma transação.
- **Compute medido** (13 rodadas do teste `compute_units`, 2026-10-28; compra, venda e `settle` medidos de novo em 2026-11-09, com a curva única e a linha no market cap):

  | Operação | Compute |
  |---|---|
  | lançamento | 79 mil a 98 mil |
  | lançamento com o `commit` do criador | 94 mil a 117 mil |
  | primeira compra (com criação da conta) | 32 mil a 37 mil |
  | compra | 20 mil a 23 mil |
  | venda | 13 mil |
  | compra que cruza a linha | 21 mil a 24 mil (era 25 mil a 30 mil, com a queima) |
  | `commit` num assento novo / num que já existe | 15 mil a 22 mil / 11 mil a 18 mil |
  | `withdraw` | 8 mil |
  | `settle` sem / cruzando a linha | 7,3 mil / 8,0 mil (era 7 mil / 13 mil, com a queima) |
  | `claim_seat` (com criação da conta) | 32 mil a 35 mil |

  Só a instrução do pool, o binário no ar (671ae17) contra o novo, nas mesmas pools (teste de upgrade, 2026-11-09, com a linha no market cap): compra 15.009 → 15.337; compra que cruza a linha 21.070 → 16.185; venda 12.245 → 12.638; `settle` que cruza 12.871 → 7.805; compra numa pool que a primeira versão graduou 15.008 → 15.334; `claim_seat` num lote que o binário no ar fechou 15.150 → 15.150. A parte do pool custa cerca de 200 a 280 a cada negociação, e a conta da linha em u128 cerca de 120 (com a linha no SOL real eram 15.219, 16.066, 12.521 e 7.686); sem a queima, cruzar a linha ficou 5 mil mais barato.

  Os números mudam de rodada para rodada: as chaves dos testes são novas a cada vez, e cada tentativa a mais na busca do bump de uma PDA custa 1,5 mil. O teste confere contra os limites que o site pede: 200 mil para o lançamento (com compra ou `commit`), 80 mil para a compra (uma primeira compra que abre a conta e cruza a linha chegou a 61 mil num endereço que já tinha SOL, com a queima; agora 54 mil), 40 mil para a venda, 50 mil para o `commit`, 20 mil para o `withdraw`, 60 mil para o `settle` e 80 mil para o `claim_seat` (a conta de token aberta junto também busca um bump; numa rodada chegou a 46 mil). O mais justo é o `commit`: com 15 mil de base, os 50 mil cobrem 23 tentativas a mais na busca do bump do assento (com 30 mil, cerca de 1 par moeda e carteira em 2 mil falharia sempre).

## Segurança sem auditoria (por enquanto)

1. **Anchor 1.2**, com `seeds`, `has_one` e `address` em toda conta.
2. **Reservas anotadas**: doação direta não muda o preço.
3. **Matemática em u128, arredondando a favor do pool, com `min_out` obrigatório.**
4. **Sem token de LP.**
5. **O admin não alcança o dinheiro dos pools**; a tesouraria de cada pool é fixa; as vendas não pausam.
6. **Mint fechado**: só os metadados, nenhuma autoridade, conferido depois de criar.
7. **Tetos fixos** para taxas e curva.
8. **O mint é uma PDA do programa** (2026-10-28), o que fecha na raiz o ataque das contas "intransferíveis": antes, quem tinha a chave de um endereço podia criar ali um mint com extensões, abrir contas para outras carteiras, fechar o mint e lançar a moeda no mesmo endereço, e as contas antigas ficavam com a marca. Agora não há chave: o lançamento num endereço que não é o do programa é recusado. A defesa antiga continua: **o pool só paga em contas limpas** (recusa contas congeladas ou com extensões herdadas).
9. **Multisig com timelock** para a autoridade de upgrade e o admin da config, antes da mainnet. O kit está em `../deploy/` (roteiro em `../deploy/MAINNET.md`): deploy num ID novo, config com os lançamentos fechados, multisig Squads v4 sem "config authority", prova das chaves de cada membro, passagem da autoridade e do admin ao vault numa transação, e upgrades e mudanças de config por votação. Ensaiado inteiro na devnet em 2026-10-29, num programa de teste (`AC6DWrFx…gf59`), sem tocar no `CbAjrr…`.
10. **Começo controlado**: só a equipe lança.

Testes:
- 17 de matemática em `src/math.rs` (os números da linha; a conta da linha cabe em u128 até nos maiores u64; a compra de exatamente `graduation_sol` numa pool nova, na linha (a igualdade `x·S = M·T`, como 10/40, conta como graduada) ou um fio abaixo, e com a taxa abaixo; cruzar a linha não muda preço nem supply; uma compra ou duas dão o mesmo, menos o arredondamento; `graduated` liga e desliga com o market cap e só a subida gradua; muito volume e pouca compra não graduam antes dos 420, mesmo com o SOL real bem acima de `graduation_sol`; a curva vale a vida toda, com `k` que nunca cai, a reserva que nunca passa do supply, o predicado do market cap a cada passo e nenhuma venda que suba o preço; saída total sem recusa; a venda que satura em vez de falhar; quem negocia sozinho nunca ganha e os livros fecham a cada passo, com 0%, 20% e 100% no pool; a taxa contada uma vez só; as pools que a primeira versão graduou negociam com os mesmos inteiros dela, conferidos contra uma cópia da matemática antiga, e ficam graduadas para sempre; as que ela deixou abaixo da linha negociam igual até a linha) e 1 de layout em `src/state.rs`; `reference/props.js` confere o predicado do market cap a cada passo, a compra de exatamente `graduation_sol` em cada pool nova e as idas e voltas sem graduar;
- 36 de integração em LiteSVM com o Token-2022 de verdade (`../pool-tests`), o passeio aleatório conferindo o predicado do market cap a cada passo, a moeda com muito volume e pouca compra que não gradua antes dos 420 (403 idas e voltas de 60 SOL, o SOL real passa de `graduation_sol` com o market cap em cerca de 152) e a compra de exatamente `graduation_sol` numa moeda nova, mais 2 de cadeias gêmeas que só o `../upgrade-test.sh` roda (precisam do binário no ar), entre eles o ataque das contas "intransferíveis" (agora recusado no lançamento), o endereço que pertence ao criador e ao salt, e o lote de abertura (um preço para todos os assentos, a ordem das janelas, o saque total que fecha o assento e o `commit` que o abre de novo, o reembolso, o lote que cruza a linha (com `Graduated` antes de `Settled`), a graduação ao vivo (sobe, desce, sobe de novo, e `Graduated` só na subida), os 20% da taxa no pool (eventos com `pool_fee`, livros, saques, a divisão 50/30/20 com a config a 3.750), os limites da janela, a janela mínima com o `commit` do criador no lançamento, o compute de cada passo), e mais: nada entra nem sai de um assento depois do `settle`, o reembolso com vários assentos e negociação antes dos resgates, o lote que cai abaixo do mínimo no último segundo, contas trocadas em cada passo do lote, um passeio aleatório com lote que confere os livros a cada passo, a graduação antes dos resgates, os valores mínimos, os bytes de cada evento na posição que o site e o servidor leem, e o pior caso de compute contra os limites do site; e um upgrade no meio de dois lotes abertos (um que compra na curva e um que devolve o SOL), com tudo resgatado depois;
- `../upgrade-test.sh` compila a versão que está no ar (671ae17, os mesmos bytes da devnet), lança e negocia moedas com ela em duas cadeias iguais, faz o upgrade pelo loader numa delas e repete os mesmos passos nas duas: a moeda que o binário no ar graduou (com queima) negocia com os mesmos inteiros, lamport por lamport, e continua graduada vendida até o fim, com o market cap (lido como o de uma moeda nova) em cerca de 51 SOL; a que estava abaixo da linha negocia igual até a linha e, ali, o binário no ar queima e o novo segue a curva; o lote aberto durante o upgrade cruza a linha na curva; nenhuma pool antiga guarda parte da taxa, e uma moeda lançada depois guarda os 20%. Um segundo teste de cadeias gêmeas (`upgrade_keeps_the_batches_the_live_binary_ended`) faz o mesmo com três lotes que o binário no ar fechou antes do upgrade: um abaixo da linha, um acima (com queima) e um reembolsado, com um assento resgatado antes e os outros depois; cada resgate dá os mesmos tokens e o mesmo SOL, lamport por lamport, e as moedas negociam igual. Os testes imprimem o compute de cada passo nos dois binários. O mesmo script passa o binário no ar ao teste do upgrade no meio de um lote. **Depois deste upgrade não há volta para 671ae17**, já a partir das primeiras negociações de uma pool lançada depois dele, antes de qualquer pool passar da linha. O binário antigo mede a linha pelo SOL real (`graduation_sol`), e a parte da taxa que fica no pool sobe `k`, então o SOL real de uma pool nova passa de `graduation_sol` antes do market cap chegar à linha. Os três casos: (a) com o SOL real acima de `graduation_sol` e o market cap abaixo da linha, o binário antigo recusa toda compra (`MathOverflow` em `graduation_sol − real_sol`; as vendas passam), e para chegar aí basta uma compra de 82,95 SOL a 1% numa moeda 30/420 (82,29 reais, market cap de 419,65) ou cerca de 40 mil SOL de idas e voltas; (b) com o SOL real ainda abaixo, a compra que chega a `graduation_sol` queima e gradua do jeito antigo com o market cap abaixo do escolhido (cerca de 288 SOL em vez de 420, depois de 10 mil SOL de volume a 1%), e de volta ao código novo a pool fica na regra de legado para sempre (sem a parte da taxa, graduada mesmo vendida até o fim); (c) passada a linha (`graduated` = 1, `burned` = 0, o virtual ainda valendo; vale também para uma pool antiga que o código novo levou além da linha), o binário antigo a lê como pool só de SOL real, e o preço cai na hora pela fração `V/(V+R)` (27% na linha); quem compra nessa janela leva tokens baratos (um revisor mediu, com 99 SOL reais: +29,9% de tokens por SOL na compra, −21,9% de SOL na venda). Uma correção de emergência deve partir do código novo. Antes de um upgrade da mainnet, o commit que estiver no ar vai em `old` no script, compilado de novo para o endereço dos testes, e é o ponto de partida dos dois testes (`POOL_SO_LIVE`; `../deploy/MAINNET.md`, "Um upgrade depois"). O `solana program dump` não serve: o binário no ar leva o ID da mainnet e recusa rodar em outro endereço. Cuidado com a ordem: o Anchor aceita bytes a mais nos argumentos, então um site novo que mande um `launch` com lote para um programa antigo, sem o `commit` do criador, cria uma moeda sem lote sem erro nenhum. O programa sobe antes do site;
- na devnet, `site/chain/batch-check.mjs` faz um lote de verdade pelo pacote do site, e `site/chain/seats-check.mjs` faz três ao mesmo tempo com seis carteiras: um que compra (quatro assentos, cada resgate conferido até a unidade), um reembolso e um vazio;
- `../test.sh` roda tudo.

O binário tem 475 KB (486.808 bytes; eram 486.304 com a linha no SOL real e 490.736 com a queima). Pelo aluguel medido em 2026-10-29 (5.080 lamports por byte, contando os 45 do cabeçalho e os 128 da conta), são cerca de 2,47 SOL para o binário e 3,09 SOL com os 25 % de folga que o deploy da mainnet reserva.

## Revisões (2026-10-22)

- **Desenho:** um revisor tentou quebrar, outro conferiu as ferramentas, um terceiro refez a matemática. Acharam o `init_config` aberto, a falta de tetos e a graduação que comprava tudo com liquidez virtual. Tudo corrigido.
- **Código:** dois revisores. Acharam as contas "intransferíveis" deixadas por um mint anterior, as taxas que mudavam de dono na troca de criador, a tesouraria sem validação, um tamanho de metadados que travava o lançamento, os códigos de erro e a falta de eventos. Tudo corrigido e coberto por testes.

## Fora da v1

Hooks, Jupiter e OKX (exigem SDK), LP de terceiros, pares além do SOL, taxa de transferência e auditoria.

## Etapas

1. ~~Programa e testes locais.~~
2. ~~Devnet.~~
3. **Site próprio**, em andamento.
4. **Mainnet**: carteira nova, multisig, deploy (cerca de 3,09 SOL de aluguel, com a folga) e o token principal do projeto lançado na DBC normal, decisão do usuário. O roteiro está ensaiado (`../deploy/MAINNET.md`); falta a carteira, os membros da multisig e um nó pago.

## Em aberto

- Nome e marca.
- ~~Se a graduação sobe para 450 SOL, para os sites mostrarem 420 depois da queima.~~ Fechado em 2026-11-09: sem queima, a linha é o market cap de 420 SOL no supply inteiro, que é o que existe, com ou sem volume antes. Com volume, a parte do pool só faz a moeda precisar de mais SOL real para chegar lá ("Números da curva"); os sites medem o caminho como o programa.
- O mint continua gravável em `buy`, `sell` e `settle` sem precisar; tirar o `mut` deixaria a lista de contas aceitar mint só leitura, mas os testes de upgrade passariam a montar as contas à mão para o binário antigo.
