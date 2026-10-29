Que bom que resolveu. Se o bloqueio voltar, rode este comando como root no servidor. Ele fecha o Chrome, guarda o perfil atual como backup com data e hora, e em até 1 minuto o vigia abre um Chrome limpo:

pkill -u viralizeai -f "[c]hrome-tfg-debug"; sleep 3; mv /home/viralizeai/.config/chrome-tfg-debug /home/viralizeai/.config/chrome-tfg-debug.bak-$(date +%Y%m%d%H%M); pkill -u viralizeai -f "[c]hrome-tfg-debug"; ls -d /home/viralizeai/.config/chrome-tfg-debug*

Depois de rodar:

Espere ~1 minuto e abra o VNC.
Entre de novo no ChatGPT e no Claude, porque o perfil novo vem sem login.
Na página /claude do ViralizeAI, clique em “Testar” (e em “Autorizar”, se ele pedir).

Se só reiniciar o Chrome já resolver, sem perder os logins, este comando fecha o Chrome e o vigia reabre com o mesmo perfil. Vale tentar este primeiro:

pkill -u viralizeai -f "[c]hrome-tfg-debug"

Cada reset deixa uma pasta .bak-… de backup, e elas ocupam espaço. Com tudo funcionando, dá para listar:

ls -d /home/viralizeai/.config/chrome-tfg-debug.bak-*

E apagar as antigas. Atenção: isto apaga de vez, então só rode quando tiver certeza de que o Chrome atual está ok:

rm -rf /home/viralizeai/.config/chrome-tfg-debug.bak-*

Se mesmo com o perfil zerado tudo continuar caindo no Cloudflare, o problema não é o navegador, é o IP do servidor. Aí me chame que vemos as opções.
