@echo off
echo 🚀 Pulizia vecchi moduli e lock file...
rmdir /s /q node_modules
del package-lock.json

echo 📦 Reinstallazione dipendenze...
npm install

echo 🌐 Deploy su Vercel (forzato)...
vercel --prod --force

pause