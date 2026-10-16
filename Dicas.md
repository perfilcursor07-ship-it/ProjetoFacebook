
-- Local
git pull
npm install
npm run migrate
npm run seed
npm run build:css
npm run dev

PRODUÇÃO
git pull --ff-only origin main

RAPIDO
su - viralizeai -c 'set -e; export PATH=/home/viralizeai/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin; cd /home/viralizeai/htdocs/www.viralizeai.online; git checkout -- public/css/app.css; ANTES=$(git rev-parse HEAD); git pull --ff-only origin main; if git diff --name-only "$ANTES" HEAD | grep -q "^package-lock.json$"; then npm ci --omit=dev; fi; npm run migrate; npm run build:css; npm run gateway:sync; pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env; pm2 save; for i in $(seq 1 15); do curl -fsS http://127.0.0.1:3010/health && break; sleep 2; done; pm2 status viralizeai'


SUBIR GIT
git add .
git commit -m "feat: sua mensagem aqui"
git push origin main


CLAUDE EXIBIR AUTENTICAÇÃO
Abre Powershell
ssh -N -L 6080:127.0.0.1:6080 viralizeai@www.viralizeai.online

Entra no link
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote



Para acompanhar ao vivo:
su - viralizeai -c 'export PATH=/home/viralizeai/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin; node /home/viralizeai/.nvm/versions/node/v22.23.1/lib/node_modules/pm2/bin/pm2 logs viralizeai --lines 80'

limpar servidor
cd /home/viralizeai/htdocs/www.viralizeai.online
node scripts/fechar-abas-chrome.js --listar
node scripts/fechar-abas-chrome.js
node scripts/fechar-abas-chrome.js --todas