# Desligar o monitor (e suspender) com o screensaver rodando, conforme a configuração do sistema

## Context
Hoje o mpv é lançado com o padrão `--stop-screensaver=yes`: ele **inibe** a ociosidade da sessão. Resultado: enquanto o vídeo roda, o GNOME nunca chega ao estado "ocioso", então a tela nunca apaga e o PC nunca suspende, mesmo que configurado em *Configurações → Energia*. O usuário quer que, com o screensaver rodando, o monitor desligue **se houver configuração** para isso, e que a suspensão também funcione no código (hoje ele deixa suspensão desligada).

Como o GNOME faz (lido em `screenShield.js` do GNOME 50): após `org.gnome.desktop.session idle-delay` segundos sem input e sem inibidores, a sessão fica IDLE → o Shell escurece a tela (`ScreenShield` fica `active`, emite `active-changed`, bloqueia se `lock-enabled`) e o gnome-settings-daemon desliga o monitor; a suspensão vem de `sleep-inactive-ac-type/timeout`. Tudo isso já respeita as configurações do usuário — basta o mpv parar de bloquear.

Estado atual da máquina: `idle-delay = 0` (Tela em branco: **Nunca**), suspensão `nothing`, `lock-enabled = true`. Ou seja, para ver o efeito o usuário precisa escolher um tempo em *Energia → Tela em branco*.

## Mudanças (`extension.js`)
**T-01 mpv não inibe mais a ociosidade** — em `_launchMpv()` adicionar `'--stop-screensaver=no'` ao argv. Com isso o GNOME segue o próprio relógio: apaga a tela após `idle-delay` e suspende se configurado. Se "Nunca", nada muda (vídeo roda como hoje).

**T-02 Parar o mpv quando a tela apagar/bloquear** — evita o mpv decodificando vídeo atrás da tela apagada a noite toda (CPU/GPU/áudio).
- Em `enable()`: `this._shieldId = Main.screenShield?.connect('active-changed', ...)`; quando `Main.screenShield.active` e `this._screensaverActive` → `this._stopScreensaver(false, true)` (sem chamar nosso lock: o GNOME já bloqueia conforme `lock-enabled`).
- Em `disable()`: desconectar `_shieldId`.
- Suspensão continua coberta pelo `PrepareForSleep` já existente (`_connectLogind`).

**T-03 Não iniciar com a tela já apagada** — em `activateScreensaver()`, ampliar o guard atual (`Main.sessionMode.isLocked`) para também `Main.screenShield?.active`. Cobre o caso `idle-delay` < tempo do screensaver: a tela apaga primeiro e o screensaver não deve acordar nada por trás.

**T-04 Documentação** — README (seção "Fill screen and background" → nova nota "Power settings"): a tela apaga/suspende conforme *Configurações → Energia*; com "Tela em branco: Nunca" o vídeo roda indefinidamente. Atualizar o texto do `README` que diz que mpv impede o screensaver, se houver.

## Fluxo (SDD)
Mesma branch. T-00: este plano em `specs/003-energia/spec.md` → commit; 1 tarefa = 1 commit.

## Critérios de aceite
- AC-01 argv do mpv contém `--stop-screensaver=no`.
- AC-02 Com Tela em branco = N min e screensaver rodando, a tela apaga em N min de inatividade e o mpv é encerrado.
- AC-03 Com Tela em branco = Nunca, comportamento idêntico ao atual.
- AC-04 Se a tela já está apagada/bloqueada, o screensaver não inicia.

## Verificação
- `node --check extension.js`.
- Simulador (`./dev.sh` / harness com perfil próprio): disparar o screensaver por inatividade e conferir `--stop-screensaver=no` no `pgrep -a mpv`; log sem `JS ERROR`. (O apagamento da tela depende do gnome-session/gnome-settings-daemon, que não rodam no simulador — não dá para testar AC-02 nele.)
- Sessão real (após logout/login, pelo usuário): `gsettings set org.gnome.desktop.session idle-delay 120` e screensaver em 1 min → ao 1º min o vídeo abre, ao 2º a tela escurece/apaga; ao voltar, `pgrep mpv` vazio. Depois restaurar a preferência desejada em Configurações → Energia.

## Achados
- Multi-monitor no Wayland (`--screen` ignorado) continua pendente.
