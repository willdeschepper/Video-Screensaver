# Robustez: não travar o GNOME + análise do log do simulador

## Context
O usuário rodou `./dev.sh` e pediu análise do log, com ênfase em **não travar o Ubuntu**. Uma extensão roda *dentro* do processo do gnome-shell: qualquer operação bloqueante na thread principal congela mouse, teclado e tela inteira (no Wayland não tem como "matar só a extensão").

### Leitura do log (nenhum erro vem da nossa extensão)
- Nenhum `JS ERROR` nem mensagem `[VideoScreensaver]`. Extensão carregou e o screensaver abriu ~11 vezes sem falha.
- `St-CRITICAL ... DashToDock ... not in the stage` (centenas) e `Spurious clutter_actor_allocate ... dashtodockContainer` → **ubuntu-dock** inicializando no devkit. Não é nosso.
- `meta_window_set_stack_position_no_sync` + `Failed to inhibit: org.freedesktop.ScreenSaver` em pares → cada abertura do mpv; o inhibit falha só porque o barramento privado do simulador não tem esse serviço. Inofensivo.
- `org.freedesktop.secrets` timeout, `systemd1` ausente, `fusermount3 gvfs`, `Tracker database is locked` → limitações do ambiente aninhado (barramento D-Bus privado). Não ocorrem na sessão real.
- **`Failed to create file /run/user/1000/gnome-shell-disable-extensions: File exists`** → relevante: o simulador compartilha `/run/user/1000` com a sessão real. Esse arquivo é a proteção anti-crash do GNOME (se existir quando o shell inicia, ele sobe com TODAS as extensões desligadas). Ele ficou para trás de execuções minhas encerradas à força; se o shell é morto antes de 60 s (Ctrl+C), sobra de novo.

### Riscos reais de travamento/lentidão encontrados no código
1. **Preventivo – I/O de disco síncrono na thread do shell** (`extension.js` `_startPlayer` → `GLib.file_test` + `_listVideoFiles` com `enumerate_children`/`next_file` síncronos). Na máquina atual não é problema: `/mnt/ARQUIVOS` é NVMe local (`/dev/nvme0n1p3`, ext4), sem repouso, leitura em milissegundos — **não precisa mover os vídeos**. O risco aparece se a pasta um dia ficar em HD mecânico, pendrive/USB ou rede (montagem pendurada = desktop congelado). A correção é barata e torna a extensão segura independente de onde está a pasta.
2. **Perigoso – `_killOrphanedPlayer`** faz `kill <pid>` de um PID salvo em `/run/user/1000/video-screensaver.pid` sem conferir de quem é. PID reutilizado (ou o simulador lendo o arquivo da sessão real, já que compartilham a pasta) → mata processo errado. Só guarda o PID do monitor 0.
3. **Fluidez – slider do menu do painel**: cada pixel arrastado grava no dconf e recria o idle watch (`notify::value` → `set_int` → `_applyIdleMonitor`).
4. **Recurso – dispara com a tela bloqueada**: mpv decodifica vídeo (e toca áudio) escondido atrás da tela de bloqueio a noite toda.

## Fluxo (SDD)
- Mesma branch `feat/fill-and-background`. T-00: gravar como `specs/002-robustez/spec.md` → commit. 1 tarefa = 1 commit.

## Critérios de aceite
- AC-01 Nenhuma chamada de disco síncrona sobre a pasta de vídeos na thread do shell; listar uma pasta lenta não congela a interface.
- AC-02 Só envia sinal a PIDs cujo `/proc/<pid>/comm` é `mpv`; todos os PIDs (todos os monitores) são registrados e limpos.
- AC-03 Arrastar o slider grava a configuração uma vez ao parar (debounce ~300 ms), mantendo o rótulo atualizado ao vivo.
- AC-04 Não inicia com a sessão bloqueada (`Main.sessionMode.isLocked`).
- AC-05 `dev.sh` remove o `gnome-shell-disable-extensions` que o simulador deixar para trás (só se não existia antes de abrir).

## Tarefas
**T-01 Listagem assíncrona** — `extension.js`
- `_startPlayer()` vira `async`; troca `GLib.file_test(IS_DIR)` por `query_info_async('standard::type')` e `_listVideoFiles` por `enumerate_children_async` + `next_files_async(50)` em loop + `close_async` (usar `Gio._promisify` nos métodos de `Gio.File`/`Gio.FileEnumerator`, padrão GNOME 45+).
- Após o `await`, se `!this._screensaverActive` (usuário mexeu ou disable rodou) → não lança mpv.
- `activateScreensaver()` chama `this._startPlayer().catch(e => this._showError(...))`.

**T-02 Kill seguro** — `extension.js`
- Marker passa a guardar todos os PIDs (um por linha), escrito após lançar todos os processos.
- `_killOrphanedPlayer`: para cada PID inteiro > 0, ler `/proc/<pid>/comm` (async) e só matar se `=== 'mpv'`; matar via `GLib.spawn_async`/`Gio.Subprocess(['kill', pid])` sem string de shell.

**T-03 Debounce do slider** — `extension.js` `VideoScreensaverIndicator`
- `notify::value` atualiza só o rótulo e (re)agenda `GLib.timeout_add(…, 300)` que grava `idle-timeout-minutes`; `destroy()` remove o timeout pendente.

**T-04 Não iniciar bloqueado** — `extension.js` `activateScreensaver()`: `if (Main.sessionMode.isLocked) return;`.

**T-05 dev.sh** — guardar se `$XDG_RUNTIME_DIR/gnome-shell-disable-extensions` existia; trocar `exec` por execução normal + `trap` em EXIT que remove o arquivo se não existia antes. Comentário: fechar pela janela (não Ctrl+C) é o caminho limpo.

**T-06 dev.sh encerra mpv órfão** (achado no teste e2e) — se o shell aninhado cai, o mpv que ele abriu continua decodificando sem tela. `dev.sh` exporta `VIDEO_SCREENSAVER_DEV_SESSION=$$` e, na saída, encerra só os `mpv` cujo `/proc/<pid>/environ` tem essa marca (o mpv da sessão real nunca a tem).

## Verificação
- `node --check extension.js`, `bash -n dev.sh`, schema dry-run.
- Simulador (`./dev.sh`): "Start Screensaver Now" em pasta válida, pasta inexistente e pasta vazia → vídeo/erro corretos; log sem `JS ERROR`.
- Teste de não-congelamento: apontar a pasta para um diretório FUSE lento ou `sshfs` indisponível é difícil; em vez disso, simular com uma pasta de ~5 000 arquivos e confirmar que o painel continua respondendo (o relógio/menus animam) durante a listagem.
- Kill seguro: escrever no marker o PID de um `sleep 300` → ao habilitar a extensão o `sleep` **não** morre; com PID de um mpv de teste → morre.
- Slider: arrastar e conferir com `dconf watch /org/gnome/shell/extensions/video-screensaver/` que há uma única gravação.
- dev.sh: abrir e matar com Ctrl+C em < 60 s → `/run/user/1000/gnome-shell-disable-extensions` não existe depois.

## Achados (fora do escopo)
- Multi-monitor no Wayland: `--screen/--fs-screen` são ignorados → N mpv no mesmo monitor (decodificação dobrada). Possível correção futura com `--fs-screen-name=<conector>`.
- O mpv inibe o apagamento da tela: com o screensaver rodando, o monitor nunca desliga (DPMS). Talvez opção "parar após X minutos".
- `install.sh` imprime "Could not enable extension automatically" no `dev.sh` (esperado; a sessão real ainda não conhece a extensão).
