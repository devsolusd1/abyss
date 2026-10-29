# Mainnet: o roteiro

O programa sobe para a mainnet num endereço novo, com uma carteira só para isso, e passa logo para uma multisig. Quem assina e envia é você. Os scripts desta pasta, sem `SEND=1`, só leem a rede e simulam: mostram o plano, os custos, as chaves públicas e o que daria errado. O ensaio desse mesmo roteiro é na devnet, com um ID novo (no fim).

Tudo roda no WSL, a partir da raiz do repositório, com o PATH do `programs/test.sh`. Uma vez: `cd programs/deploy && npm install`.

Duas regras valem para o roteiro inteiro:

- **O CLI `solana` só pelo `sol.sh`.** Num erro de rede, o CLI imprime a URL inteira do nó, com a chave. `bash programs/deploy/sol.sh <comando>` põe o nó do `CLUSTER` e filtra tudo o que o CLI imprime. Nunca rode `solana ... --url "$RPC_URL"` direto, nem com `-v`, nem `solana config get`.
- **Cada script confere o nó.** Todos perguntam ao nó o hash do gênesis e param se ele não for do `CLUSTER`. Um `RPC_URL` da mainnet que ficou no shell não faz um passo do ensaio cair na mainnet, nem o contrário.

## O que preparar

- **Uma carteira nova, só para o deploy.** Rode no seu próprio terminal, fora do Claude (nem no painel de terminal do Claude Code, que o agente consegue ler), e anote a frase de recuperação no papel:

  ```
  solana-keygen new -o ~/nox-keys/mainnet-deploy.json
  ```

  Ela paga tudo e é a autoridade de upgrade até a passagem para a multisig. Depois disso não manda em mais nada: não pode ser o `launcher` nem a tesouraria (o `init-config.mjs` recusa).
- **Uns 4 SOL nela, e 5 para ter folga.** O que fica preso no programa é o aluguel do espaço do binário: cerca de 3,1 SOL hoje, com a folga de 25 % para upgrades maiores (a tabela abaixo). O buffer não é pago duas vezes: o CLI cobra o aluguel do buffer no começo, e no fim o loader devolve esse SOL e paga com ele o aluguel do programa. A folga cobre as taxas, as novas tentativas e a multisig. Só um deploy que cai e recomeça com **outro** buffer pede o aluguel de novo; por isso o script usa sempre o mesmo.
- **Um nó pago** da mainnet (Helius, Triton, QuickNode). A URL leva a chave: os scripts nunca a imprimem. Para ela não ir para o histórico do shell:

  ```
  read -rsp 'RPC_URL: ' RPC_URL && export RPC_URL
  ```

- **As chaves públicas dos membros da multisig**, cada uma conferida na carteira do próprio membro. Três membros e duas assinaturas é o desenho. Decida também o **timelock**: quanto tempo uma mudança aprovada espera antes de valer (por exemplo um dia, `86400`; na mainnet o `create`, a passagem e o `check-deploy.mjs` recusam menos de uma hora). Ele dá tempo de ver um upgrade estranho, mas também atrasa uma correção urgente.
- **A carteira da equipe que lança** (o `launcher`) e a **tesouraria** (uma carteira comum que já tenha o próprio aluguel, uns 0,001 SOL). Nenhuma das duas é a carteira do deploy.

Opcional: um ID com cara de Nox. Faça o keypair **dentro de `~/nox-release/mainnet`**, onde o `deploy.sh` o procura, e nunca na raiz do repositório: o repositório é público. O `.gitignore` pega `*nox.json`, `program.json`, `buffer.json` e qualquer `.json` solto em `programs/deploy`, e o `deploy.sh` recusa uma chave dentro do repositório, mas o lugar dela é fora dele.

```
mkdir -p ~/nox-release/mainnet && cd ~/nox-release/mainnet
solana-keygen grind --ends-with nox:1
mv ./*nox.json program.json         # o único arquivo que ele gravou, <endereço>.json
cd -
```

Sem o grind, o primeiro modo seco do deploy faz o endereço com `NEW_PROGRAM=1`.

## Custos (medidos na mainnet em 2026-10-29)

| O quê | SOL | Volta? |
|---|---|---|
| Aluguel do programa: binário de 490.736 bytes mais 25 % de espaço | cerca de 3,12 | não: fica no programa |
| Dos quais o espaço a mais (`ROOM_PCT=25`, cerca de 120 KB) | 0,62 | não |
| Cada 64 KB de espaço a mais | 0,333 | não |
| Aluguel da conta do programa | 0,0008 | não |
| Taxas do deploy (cerca de 510 escritas) | cerca de 0,004 | não |
| Aluguel da config | 0,0012 | não |
| Multisig: aluguel da conta e a taxa da Squads | o `multisig.mjs create` mostra | não |
| Um upgrade depois: o buffer do binário novo | cerca de 2,5, enquanto durarem os votos e o timelock (pelo menos um dia com `86400`) | sim, no upgrade |

O aluguel caiu desde o DESIGN.md (3,4 SOL então, sem folga): o `deploy.sh` lê os valores da rede na hora.

## A ordem

Em cada passo, rode primeiro sem `SEND=1`, leia o que ele mostra, e só então repita com `SEND=1`. As variáveis de sempre:

```
export CLUSTER=mainnet KEYPAIR=~/nox-keys/mainnet-deploy.json     # e o RPC_URL, como acima
```

1. **O commit.** Tudo o que vai subir está commitado e no `origin/main` (faça `git fetch`). O `build.sh` recusa `programs/pool` com mudanças não commitadas, e o `deploy.sh` recusa na mainnet um commit que não está no `origin/main`: um binário cuja fonte não está em lugar nenhum não se confere nem se recompila depois.

2. **O deploy.**

   ```
   bash programs/deploy/deploy.sh                  # com o program.json do grind
   NEW_PROGRAM=1 bash programs/deploy/deploy.sh    # sem grind: faz ~/nox-release/mainnet/program.json
   ```

   Ele faz `buffer.json` ao lado do `program.json`, compila o commit com esse ID (`~/nox-release/<ID>/dex.so` e `build.json`) e mostra o ID, o espaço, o aluguel, as taxas, o saldo, o que falta e o comando exato. O espaço é o binário mais 25 % (`ROOM_PCT=` ou `MAX_LEN=` mudam): um upgrade maior depois precisaria aumentar o programa, e quando a rede ativar o `ExtendProgramChecked` (pronto, ainda não ativado) só a multisig vai poder fazer isso, coisa que o kit não faz. A taxa de prioridade sai do que as transações pagantes pagaram nos últimos slots, com piso de 500.000 micro-lamports por unidade. Na prática vale o piso: o nó mostra 0 em quase todos os slots (todos os 150, medido em 2026-10-29). Isso dá menos de 0,001 SOL de prioridade no deploy inteiro. Se a rede estiver congestionada, `PRICE=` fixa outra, por exemplo a estimativa do seu nó pago; o `multisig.mjs` aceita o mesmo `PRICE=` (ou `PRIORITY_FEE=`).

   As cerca de 500 escritas vão pelo nó pago na mainnet (`--use-rpc`) e direto aos validadores na devnet (`USE_RPC=0` ou `1` troca). No ensaio, o nó público da devnet recusou a maior parte das escritas (erro 429) e o deploy parou duas vezes, com 2 % e com 7 % do binário no buffer; mandando direto aos validadores, o mesmo comando retomou do buffer e terminou de uma vez. Se o nó pago também recusar, `USE_RPC=0` é a saída.

   Para enviar, o ID que o modo seco mostrou vai junto, escrito por você:

   ```
   SEND=1 PROGRAM=<ID> bash programs/deploy/deploy.sh
   ```

   Se o `PROGRAM` não bater com o `program.json`, ele para: o envio nunca cai num endereço que não foi o lido e orçado. Depois ele confere tudo com o `check-deploy.mjs` e grava `~/nox-release/mainnet/deployed.json` (o ID, quem pagou, o commit, o build). Ele recusa um ID onde já existe programa de outra autoridade: upgrade é pela multisig.

   **Guarde `program.json` e `deployed.json`**, com cópia fora do repositório. Sem o `program.json`, o `deploy.sh` faria outro ID; na mainnet ele recusa sem `NEW_PROGRAM=1`, e com o `deployed.json` ele recusa em qualquer rede.

3. **A config, com os lançamentos fechados.** Na mainnet, cada valor vai escrito; nada vem por padrão:

   ```
   PROGRAM=<ID> LAUNCHER=<carteira da equipe> TREASURY=<tesouraria> \
     LAUNCH_FEE=0 MIN_FEE_BPS=100 TREASURY_SHARE_BPS=5000 node programs/deploy/init-config.mjs
   ```

   Esses três números são os da config da devnet hoje, com os quais o site foi testado; `LAUNCH_FEE` é em lamports. O admin fica sendo a carteira do deploy por enquanto (a passagem precisa disso). `launches_open` sai `false`. Ele simula, e com `SEND=1` envia, reenvia a mesma transação até ela entrar ou vencer, e lê a config de volta. Só roda uma vez: se a config já existe e é igual à pedida, ele diz "already done" e sai com 0; se é outra, ele recusa.

4. **A multisig.**

   ```
   PROGRAM=<ID> MEMBERS=<a>,<b>,<c> THRESHOLD=2 TIMELOCK=86400 node programs/deploy/multisig.mjs create
   ```

   Ela sai sem "config authority": membros, threshold e timelock só mudam por votação. Ele imprime o endereço da multisig e o do vault 0: copie e cole, não digite.

   **A prova das chaves.** Antes de qualquer coisa depender da multisig, cada membro assina uma proposta inofensiva (só um memo), para um endereço digitado errado aparecer agora e não depois. Um membro propõe, os outros dois aprovam, cada um com a própria carteira:

   ```
   PROGRAM=<ID> MULTISIG=<multisig> MEMBER_KEYPAIR=<membro a> node programs/deploy/multisig.mjs propose-keycheck
   PROGRAM=<ID> MULTISIG=<multisig> INDEX=<n> MEMBER_KEYPAIR=<membro b> node programs/deploy/multisig.mjs approve
   PROGRAM=<ID> MULTISIG=<multisig> INDEX=<n> MEMBER_KEYPAIR=<membro c> node programs/deploy/multisig.mjs approve
   ```

   Quem propõe já conta. Depois de dois votos a proposta fecha para votos: num 2 de 3, um propõe e os outros dois aprovam. Sem a prova de todos os membros, a passagem recusa e diz quem falta. **Não execute nem limpe essa proposta antes da passagem:** a passagem lê quem assinou na própria proposta, e o `cleanup` a apagaria (ele a deixa de fora enquanto o vault não tem a autoridade).

5. **A passagem.**

   ```
   PROGRAM=<ID> MULTISIG=<multisig> MEMBERS=<a>,<b>,<c> THRESHOLD=2 TIMELOCK=86400 node programs/deploy/multisig.mjs handoff
   ```

   Numa transação só, o admin da config e a autoridade de upgrade vão para o vault. Ou as duas coisas acontecem, ou nenhuma. Na mainnet, `THRESHOLD` e `TIMELOCK` são obrigatórios: o script os confere contra a multisig na rede antes de entregar. Depois disso, a carteira do deploy é recusada pelo programa (ConstraintHasOne) ao mexer na config e pelo loader (IncorrectAuthority) ao mexer na autoridade, como o ensaio mostrou.

   Agora sim a prova das chaves pode ser executada (é só um memo) e limpa, e o aluguel dela volta para o vault:

   ```
   PROGRAM=<ID> MULTISIG=<multisig> INDEX=<n da prova> MEMBER_KEYPAIR=<membro> node programs/deploy/multisig.mjs execute
   PROGRAM=<ID> MULTISIG=<multisig> node programs/deploy/multisig.mjs cleanup
   ```

   Rodada de novo, a passagem diz "nothing to do: the vault holds both already".

6. **A conferência.**

   ```
   PROGRAM=<ID> BUILD=~/nox-release/<ID>/build.json MULTISIG=<multisig> \
     EXPECT_MEMBERS=<a>,<b>,<c> EXPECT_THRESHOLD=2 EXPECT_TIMELOCK=86400 \
     EXPECT_LAUNCHER=<carteira da equipe> EXPECT_TREASURY=<tesouraria> \
     EXPECT_LAUNCH_FEE=0 EXPECT_MIN_FEE_BPS=100 EXPECT_TREASURY_SHARE_BPS=5000 EXPECT_LAUNCHES_OPEN=0 SITE=0 \
     node programs/deploy/check-deploy.mjs
   ```

   Ele confere que o nó é da mainnet, que o programa é executável e do loader, que os bytes no ar são os do build (sha256) de um commit limpo, a config campo a campo, que a multisig é autônoma, tem esses membros, threshold e timelock, e que o vault 0 tem a autoridade de upgrade e o admin. Na mainnet ele falha sem `BUILD`, sem `MULTISIG` (ou `EXPECT_AUTHORITY`) e sem `EXPECT_MEMBERS`. Sai com erro se algo falhar. `SITE=0` porque o site ainda não tem o ID.

7. **O ID no site**, só agora. Primeiro ele mostra, depois escreve com `WRITE=1`:

   ```
   node programs/deploy/set-program.mjs mainnet <ID>
   WRITE=1 node programs/deploy/set-program.mjs mainnet <ID>
   git diff
   node server/check.mjs
   ```

   Ele muda só o valor do programa em `site/net.js` e em `server/config.mjs`, e confere que os dois batem.

8. **A Vercel.** Em Project, Settings, Environment Variables: `RPC_URL_MAINNET` com a URL do nó pago, e `PROGRAM_MAINNET` com o mesmo ID (ou nenhum; se tiver, vale mais que o `config.mjs`, então tem que ser igual).

9. **A última conferência e o push.** O passo 6 de novo, sem `SITE=0`: agora ele confere também os dois arquivos. Depois o commit e o push para a `main`, e a Vercel publica.

   A estreia é discreta: o `site/net.js` continua abrindo na devnet (`pick = "devnet"`), e a mainnet só aparece com `?net=mainnet`. Fazer da mainnet o padrão é outra mudança no site, decisão sua; o melhor momento é junto com a abertura dos lançamentos.

10. **Abrir os lançamentos**, quando for a hora, pela multisig:

    ```
    PROGRAM=<ID> MULTISIG=<multisig> LAUNCHES_OPEN=1 MEMBER_KEYPAIR=<membro a> node programs/deploy/multisig.mjs propose-config
    PROGRAM=<ID> MULTISIG=<multisig> INDEX=<n> MEMBER_KEYPAIR=<membro a> node programs/deploy/multisig.mjs approve
    PROGRAM=<ID> MULTISIG=<multisig> INDEX=<n> MEMBER_KEYPAIR=<membro b> node programs/deploy/multisig.mjs approve
    PROGRAM=<ID> MULTISIG=<multisig> INDEX=<n> MEMBER_KEYPAIR=<membro> node programs/deploy/multisig.mjs execute    # depois do timelock
    ```

    Cada passo é assinado por um membro, com o arquivo de chave dele nesta máquina (`MEMBER_KEYPAIR`; a carteira do deploy não é membro e é recusada). Um membro com Ledger ou Phantom aprova e executa pelo app da Squads, na mesma proposta. Depois, o passo 6 com `EXPECT_LAUNCHES_OPEN=1`.

## O que não tem volta

- **O ID do programa.** Depois do deploy ele é esse para sempre: cada moeda, cada pool e o site apontam para ele.
- **Passar a autoridade e o admin para a multisig.** Depois disso só ela muda o programa e a config. Se o grupo perder chaves e não chegar ao threshold, o programa fica como está para sempre (as moedas continuam negociando, mas nada mais muda).
- **Entregar um buffer.** O `set-buffer-authority` aceita qualquer endereço, sem assinatura. Entregue a uma chave errada (o endereço da multisig em vez do vault, um vault de outro índice), o SOL do buffer fica preso para sempre. Por isso a entrega vai dentro da proposta (`propose-upgrade`, no upgrade abaixo), para o vault lido da rede, depois de conferir os bytes: nunca digitada.
- **Fechar o programa** (`program close <ID>`). O endereço morre: nunca mais recebe um programa, e todo pool fica preso. Nunca rode isso, nem `--final`, que tira a autoridade para sempre.
- A tesouraria de cada pool é a da config no momento do lançamento; mudar a config só vale para moedas novas.

## Se cair no meio

- **O deploy.** Rode o mesmo comando, `SEND=1 PROGRAM=<ID>`, com o mesmo `buffer.json`. Se o programa ainda não existe, o CLI compara o que já está no buffer com o binário, escreve só o que falta e faz o deploy; o `deploy.sh` mostra quanto já está lá. Se o CLI parou mas a última transação entrou, o `deploy.sh` vê o programa com a sua autoridade, diz "deployed already" e só confere.
- **Desistir do deploy.** O SOL do buffer volta com `bash programs/deploy/sol.sh program close <buffer> --keypair "$KEYPAIR"`, ou de todos os buffers da carteira com `--buffers` no lugar do endereço (`bash programs/deploy/sol.sh program show --buffers --keypair "$KEYPAIR"` lista). Um deploy que terminou não deixa buffer.
- **Perdeu o `program.json` antes do deploy.** `NEW_PROGRAM=1` faz outro, e ele compila de novo para o ID novo. O buffer serve: dois builds do mesmo commit para IDs diferentes diferem em poucos pedaços (17 das 512 escritas, medido no ensaio), e só esses são reescritos.
- **A config.** Rode de novo sem `SEND=1`: se ela entrou e está como pedida, ele diz "already done".
- **A multisig, a passagem.** Cada uma é uma transação só: ou foi, ou nada mudou. Rode o script de novo sem `SEND=1` para ver em que pé está; `multisig.mjs status` mostra a multisig e as propostas.

## Um upgrade depois

O programa sobe antes do site. O Anchor aceita bytes a mais nos argumentos, então um site novo falando com um programa velho pode criar coisas erradas sem dar erro (o DESIGN.md conta o caso do `launch` com lote).

1. Mude, teste (`programs/test.sh`), commite, faça o push.
2. **Teste o upgrade a partir do que está no ar.** O binário no ar leva o ID da mainnet no `declare_id!` e recusa rodar em qualquer outro endereço (`DeclaredProgramIdMismatch`), e os testes carregam o programa em `CbAjrr…`. Por isso o `solana program dump` não serve aqui: o que vai no `POOL_SO_LIVE` é o mesmo commit, compilado de novo para o endereço dos testes. Antes de compilar o commit novo:

   ```
   PROGRAM=<ID> BUILD=~/nox-release/<ID>/build.json MULTISIG=<multisig> EXPECT_MEMBERS=<a>,<b>,<c> SITE=0 \
     node programs/deploy/check-deploy.mjs
   COMMIT=<o commit desse build.json> bash programs/deploy/build.sh CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK
   POOL_SO_LIVE=~/nox-release/CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK/dex.so bash programs/upgrade-test.sh
   ```

   A conferência prova que os bytes no ar são os desse commit (no primeiro upgrade, o do `deployed.json`); só então o build dele para `CbAjrr…` vale como "o que está no ar".
3. Guarde o build do que está no ar, e só então compile o commit novo para o mesmo ID (o `build.sh` troca o `~/nox-release/<ID>/build.json`, e nenhum script grava qual commit está no ar depois de um upgrade):

   ```
   cp ~/nox-release/<ID>/build.json ~/nox-release/<ID>/live-build.json
   bash programs/deploy/build.sh <ID>
   ```

   Se o upgrade for desistido, `COMMIT=<o commit do live-build.json> bash programs/deploy/build.sh <ID>` volta o build ao que está no ar. Depois de um upgrade que passou, o `build.json` novo passa a ser o do que está no ar.
4. Veja se cabe: o `check-deploy.mjs` mostra o espaço do programa, e a conferência do buffer (passo 6) recusa um binário maior que ele. O deploy reservou 25 %; passar disso pede um extend que o kit não faz.
5. O buffer, escrito pela carteira do deploy. O `multisig.mjs` confere antes de gastar (a multisig, a autoridade do programa, que o build é para esse ID, o espaço, o saldo), faz `~/nox-release/mainnet/upgrade-buffer.json`, escreve com a taxa de prioridade e lê o buffer de volta:

   ```
   PROGRAM=<ID> MULTISIG=<multisig> BUILD=~/nox-release/<ID>/build.json node programs/deploy/multisig.mjs write-buffer
   ```

   Primeiro sem `SEND=1`, depois com. As escritas vão pelo nó pago (`USE_RPC=0` as manda direto aos validadores, se ele recusar), com a taxa de prioridade do piso ou a de `PRICE=`. Se cair, o mesmo comando continua no mesmo buffer. Até a entrega, o SOL dele volta com `PROGRAM=<ID> BUFFER=<BUFFER> node programs/deploy/multisig.mjs close-buffer`.
6. **Uma segunda conferência do buffer**, independente da do `multisig.mjs`:

   ```
   PROGRAM=<ID> BUILD=~/nox-release/<ID>/build.json MULTISIG=<multisig> EXPECT_MEMBERS=<a>,<b>,<c> \
     BUFFER=<BUFFER> BUFFER_AUTHORITY=<endereço da KEYPAIR> SITE=0 node programs/deploy/check-deploy.mjs
   ```

   Ela confere que o build é para esse ID e leva o ID no binário, que o buffer tem exatamente esse build, que cabe no programa, que ele é da `KEYPAIR`, e que o vault 0 dessa multisig é a autoridade do programa. Não entregue o buffer à mão: o passo seguinte faz isso.
7. **A proposta**, por um membro. Ela confere os bytes do buffer contra o `BUILD` de novo e, na mesma transação, entrega o buffer ao vault e cria a proposta. Assim nunca existe um buffer entregue sem proposta, nem uma proposta com um buffer que alguém ainda pode reescrever:

   ```
   PROGRAM=<ID> MULTISIG=<multisig> BUFFER=<BUFFER> BUILD=~/nox-release/<ID>/build.json MEMBER_KEYPAIR=<membro> \
     node programs/deploy/multisig.mjs propose-upgrade
   ```

   Depois as aprovações de dois membros (`approve`, com `INDEX`, `BUILD` e o `MEMBER_KEYPAIR` de cada um; cada uma confere o buffer de novo), o timelock, e `execute` com `INDEX`, `BUILD` e o `MEMBER_KEYPAIR` de um membro (ou pelo app da Squads). Antes do timelock, o `execute` recusa e diz quantos segundos faltam. No upgrade, o buffer fecha e o SOL dele volta para a `KEYPAIR`. Se o upgrade for desistido depois da entrega, o `close-buffer` com `MULTISIG=` propõe fechar o buffer pelo vault, e o SOL volta por votação.
8. O passo 6 da ordem de novo, com o `build.json` novo e o `EXPECT_LAUNCHES_OPEN` de agora (1 depois do passo 10). Só então o push do site que depende do programa novo. No fim, `PROGRAM=<ID> MULTISIG=<multisig> node programs/deploy/multisig.mjs cleanup` (com `SEND=1`) fecha as propostas terminadas, e o aluguel delas volta para o vault.

O kit ainda não faz `extend` pelo vault: um binário maior que o espaço reservado pede esse passo novo antes do upgrade.

## O ensaio na devnet

O mesmo roteiro, com um ID novo, pago pela carteira da devnet. O site da devnet continua no programa de hoje (`CbAjrr…`), então o passo 7 fica de fora (o `set-program.mjs` recusa tirar a devnet do `CbAjrr…` sem `FORCE=1`). Na devnet não há taxa de prioridade, e o nó público serve para tudo menos as escritas do binário, que vão direto aos validadores (`USE_RPC=0`, o padrão da devnet).

**O cuidado:** a carteira da devnet também é a autoridade e o admin do `CbAjrr…`. Em todo comando do ensaio, o `PROGRAM` é o ID novo, nunca o do site. O `multisig.mjs` recusa qualquer envio com o `CbAjrr…`.

**O custo:** cada ensaio prende uns 3,12 SOL da devnet no programa de teste (com a mesma folga de 25 % da mainnet), para sempre: depois da passagem, só o vault fecha esse programa, e o kit não faz isso. O upgrade do ensaio prende mais 2,5 SOL por alguns minutos, que voltam no `execute`. Para um segundo ensaio, tire `~/nox-release/devnet/program.json` do lugar e use `NEW_PROGRAM=1` (o `deployed.json` lembra o primeiro).

```
export CLUSTER=devnet KEYPAIR=~/.config/solana/devnet.json
unset RPC_URL                       # o nó público da devnet
export REHEARSAL=1                  # três membros de teste, feitos da chave da devnet; timelock de 60 s

# o deploy e a config (cada passo primeiro sem SEND=1)
ROOM_PCT=25 bash programs/deploy/deploy.sh                        # mostra o ID novo
SEND=1 PROGRAM=<ID> ROOM_PCT=25 bash programs/deploy/deploy.sh    # se parar, o mesmo comando retoma do buffer
PROGRAM=<ID> node programs/deploy/init-config.mjs                 # e com SEND=1

# a multisig, a prova das chaves e a passagem
PROGRAM=<ID> node programs/deploy/multisig.mjs create
PROGRAM=<ID> MULTISIG=<multisig> MEMBER=1 node programs/deploy/multisig.mjs propose-keycheck
PROGRAM=<ID> MULTISIG=<multisig> INDEX=1 MEMBER=2 node programs/deploy/multisig.mjs approve
PROGRAM=<ID> MULTISIG=<multisig> INDEX=1 MEMBER=3 node programs/deploy/multisig.mjs approve
PROGRAM=<ID> MULTISIG=<multisig> THRESHOLD=2 TIMELOCK=60 node programs/deploy/multisig.mjs handoff
PROGRAM=<ID> BUILD=~/nox-release/<ID>/build.json MULTISIG=<multisig> EXPECT_MEMBERS=<m1>,<m2>,<m3> \
  EXPECT_THRESHOLD=2 EXPECT_TIMELOCK=60 EXPECT_LAUNCHES_OPEN=0 node programs/deploy/check-deploy.mjs

# abrir os lançamentos pela multisig
PROGRAM=<ID> MULTISIG=<multisig> LAUNCHES_OPEN=1 MEMBER=1 node programs/deploy/multisig.mjs propose-config
PROGRAM=<ID> MULTISIG=<multisig> INDEX=2 MEMBER=1 node programs/deploy/multisig.mjs approve
PROGRAM=<ID> MULTISIG=<multisig> INDEX=2 MEMBER=2 node programs/deploy/multisig.mjs approve
PROGRAM=<ID> MULTISIG=<multisig> INDEX=2 MEMBER=1 node programs/deploy/multisig.mjs execute     # 60 s depois

# um upgrade pela multisig, com o mesmo build (bytes iguais servem: o que se ensaia é o caminho)
export BUILD=~/nox-release/<ID>/build.json
PROGRAM=<ID> MULTISIG=<multisig> node programs/deploy/multisig.mjs write-buffer
PROGRAM=<ID> MULTISIG=<multisig> BUFFER=<BUFFER> BUFFER_AUTHORITY=<endereço da KEYPAIR> node programs/deploy/check-deploy.mjs
PROGRAM=<ID> MULTISIG=<multisig> BUFFER=<BUFFER> MEMBER=1 node programs/deploy/multisig.mjs propose-upgrade
PROGRAM=<ID> MULTISIG=<multisig> INDEX=3 MEMBER=1 node programs/deploy/multisig.mjs approve
PROGRAM=<ID> MULTISIG=<multisig> INDEX=3 MEMBER=3 node programs/deploy/multisig.mjs approve
PROGRAM=<ID> MULTISIG=<multisig> INDEX=3 MEMBER=2 node programs/deploy/multisig.mjs execute     # 60 s depois

# a prova das chaves também se executa (é só um memo), e as propostas fecham
PROGRAM=<ID> MULTISIG=<multisig> INDEX=1 MEMBER=1 node programs/deploy/multisig.mjs execute
PROGRAM=<ID> MULTISIG=<multisig> node programs/deploy/multisig.mjs cleanup

# moedas de verdade no programa novo, e o programa do site intacto
PROGRAM=<ID> KEYPAIR=~/.config/solana/devnet.json node site/chain/seats-check.mjs
PROGRAM=CbAjrrCk8WEyh9uTQ1cNJWxNGJk2ipJtxK5p8yBwnURK BUILD=~/dex-target/pool/deploy/dex.so \
  EXPECT_AUTHORITY=7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA EXPECT_ADMIN=7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA \
  EXPECT_LAUNCHES_OPEN=0 node programs/deploy/check-deploy.mjs
```

### O que o ensaio de 2026-10-29 deu

Tudo passou, do commit `683523d`.

| O quê | Endereço |
|---|---|
| Programa | `AC6DWrFxeiDbvAmE5QKXXTH2c4iriqz9YKJQ3zWwgf59` |
| Program data | `4m6tU9b5aZ5XUTzxayttJvT3XX22wpDzNX5H68HHs6xY` (613.420 bytes, 3,11705244 SOL) |
| Config | `BtC8msG2X3x8H1D71C2VG5wuKdeCUfGnPnmczbu9vq27` |
| Multisig (2 de 3, timelock 60 s) | `FbSuhbXSCCnMwTF5juGMTdaUUyCrXkAKS4JEdXhn5QzP` |
| Vault 0 (autoridade de upgrade e admin) | `FaowXaFTDV12HiSoDwEejD3yvV6baB2vksSxWrPGbCBy` |
| Membros de teste | `GonuUX9FbMTW9SKNgSBrkfaf8u51PzRmBC1ZdZsNG5Jr`, `3kRqWyiKeKVefrMX9Qi3uus5rgvQK59rhnrdNi8rEJsp`, `HWFQ3K9BtaQPDntHqEsmWrmsdsndHj8QAJ3bQJMyiH4X` |
| Moedas do teste | A `HWUGV41Be4rCEjrg7wcJfz9PMWKKkq7YRKqZdRgjhHgY`, B `HhpNRaP66b58rXCdc4eXSzZtryo8zZWFhEaAwkG1PD8J`, C `BKY5SBRSzFogWuFsZ9xDgSv36ejLkQobyaryAkteq4hc` |

- **O deploy** parou duas vezes pelo nó público (2 % e 7 % no buffer), com `--use-rpc`. Daí veio o `USE_RPC`: direto aos validadores, o mesmo comando retomou do buffer e terminou. Os bytes no ar batem com o build (sha256 `e06f1018…`), e os 122.684 bytes de folga são zeros.
- **A config** entrou como pedida, com os lançamentos fechados.
- **A multisig**: a prova das chaves passou com os três membros, e a passagem entregou a autoridade e o admin numa transação. Depois dela, simulando, a carteira do deploy é recusada pelo programa (ConstraintHasOne) ao mudar a config e pelo loader (IncorrectAuthority) ao mudar a autoridade; o vault passa nos dois.
- **A abertura dos lançamentos** pela multisig: o `execute` antes do timelock foi recusado (faltavam 51 s), e depois passou. Uma carteira de fora consegue lançar no programa do ensaio (simulado) e é recusada no do site ("team only").
- **O upgrade** pela multisig: o buffer foi escrito de uma vez, conferido duas vezes, entregue ao vault na transação da proposta, aprovado por dois membros, executado depois do timelock, e o SOL do buffer voltou. A conferência depois passou.
- **As moedas**: o `seats-check` passou inteiro no programa novo, já depois do upgrade (lote com quatro lugares, reembolso, lote vazio, vendas, histórico).
- **O programa do site** (`CbAjrr…`) ficou como estava: mesmos bytes, mesma autoridade e admin, lançamentos fechados.
- **Custo**: cerca de 3,18 SOL, quase todo o aluguel preso no programa. O aluguel das propostas fechadas (0,0144 SOL) ficou no vault.
