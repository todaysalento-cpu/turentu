import { filterDisponibilita } from './services/search/engine/availability.engine.js'; 

// 1. Dati Simulati (Corsa 764)
// Ho aggiornato i Geohash simulati affinché includano la base 'sr6uz' (Bari)
const corsaMock = [{
    id: 764,
    posti_totali: 4,
    picco_occupazione: 0,
    path_geohashes: ['sr6uzd', 'sr6v28'], // Ora il motore tronca a 5: 'sr6uz', 'sr6v2'
    percorso_polyline: 'm~prF{xaoBka@gNiiDzT_sB~jByaA|aBwaDzj@mnGnJosCre@ocCzq@gtBmq@cjBw_@{bAlwAolExbF_iKhsNivD~gDyvArxCqS~iAc_Cqj@iqCaq@ifA_aAixAbbDceCsfB}bAak@gOrr@q`DpuD_`Gn}EcmLlfI{zLtcHwpEhyB_b@z_Ey_CjiAypBbqCokHjlR__Bn_HmpDf_IczFdqYwnFdtQyRd|I}vAz_HywJjfFadC~xBu`CbvFekC~Yo}AbaFu{Ar~CsoB|cCcmDzdNeh@hzDg~A|^{j@p`Bga@v|Gi}@~rH}s@hnEdiA|pFsa@pgHya@x|@bf@vc@n\\~uDkmAzqFs{CzcEk`DnrKcwGtgd@_aE~pMyiCnhMy~@duL|{@pfJhqApvH{_@f{GdDpeHu`CxoH{}@x_EczCz|CooCjfFqtBvxK{eE`wLawEj{QiyEjhCuxCz{F}}Id{JavJpqEmtCzlFm_DrtB_jJbmH_sCZyzC_^eaFd`BulAhjDmqAdg@uaDlqA}lI|uJcjBzvE}iAlfJgu@vbO}}ChsNoiBz`EkxBr{@ofDdtEatAlmLclBj{JqyBn`GdM|pEwnClcH}aBzpAc`CnuAa{FrwEs}Aj_Dy|ArtBwlAnpE{m@|uFvc@r~CygDv`DmhApZiq@ndB}{Cv|CwbCbE{yAldAscD`cHcfDt`EwnArhEcg@rjBgaBfe@wcBrpCs`@dwCpZfaEnkAfcBpYz}Bso@lmCepC|_ByqClnBuqBi@ufDrUwwCeyB{_ApXo|@xtBulDhiEk{C|~@_tB~_Eq{@z_E_qD`yEu_CbzDisAtJst@p~@owCxcBgfCowBcjH_QceCfu@yjD~eCotDkJqfD|bBkzC~`Ai|C`s@_cBjJ{jClk@{dC}TmmEpbBw`Ibj@g~BdnAeqCbZcpFb}EklGl{A}qCxnBkwEdjAqoCbbEu~@~s@_~AkE_uFb}AgzDxnA}mEjmCicC`fCqxHjuHioAjrEseCr_DebB|jF{aDt`Dww@jGyR`cB`LvzB{|@|mByk@v`GXviCugAr_@geFni@uyAxoAgr@lpB_gAboDsyAddDqD|_Cu|@dpAgjCj}BcnJptQgtChnFulAvsIujClhDmpApgE_bExxGirAnuE_Qr~EopB|eB_wBt}DysA|tEo\\v`Hu{GblReaDbdDckBb|E{~AzzFczBfgDuiFzeNs}Svnm@crPb_m@wpNrbj@gaOl|o@ePvzCg_AlpE{rBxkAgqAzhBt~BddAv@xqAbn@{P',
    fermate_pianificate: []
}];

// 2. Richiesta di test: Bari (lat 41.11, lon 16.87) -> Bologna (lat 44.49, lon 11.34)
const richiestaTest = {
    coord: { lat: 41.1171, lon: 16.8719 },
    coordDest: { lat: 44.4949, lon: 11.3426 },
    posti_richiesti: 1
};

// 3. Esecuzione
try {
    console.log("🚀 Avvio test di compatibilità per corsa 764...");
    // Ricorda di impostare NODE_ENV=test se necessario per saltare i filtri di distanza estremi
    process.env.NODE_ENV = 'test'; 
    
    const risultato = filterDisponibilita(richiestaTest, [], [], corsaMock);
    
    console.log("=== ESITO TEST COMPATIBILITÀ ===");
    if (risultato.corse.length > 0) {
        console.log("✅ RISULTATO: Corsa compatibile trovata!");
        console.log("ID Corsa:", risultato.corse[0].id);
        console.log("Segmento visualizzato calcolato:", risultato.corse[0].percorsoVisualizzato.length, "punti.");
        console.log("Coordinate inizio segmento:", risultato.corse[0].percorsoVisualizzato[0]);
    } else {
        console.log("❌ RISULTATO: Nessuna corsa trovata.");
        console.log("Suggerimento: Verifica che il file motore_ricerca.js contenga la nuova logica di troncamento.");
    }
} catch (e) {
    console.error("💥 Errore fatale nel motore di ricerca:", e);
}