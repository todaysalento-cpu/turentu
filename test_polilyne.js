import pkg from '@googlemaps/polyline-codec';
const { decode } = pkg;

const polyline = "m~prF{xaoBukErEyuD|mEeqLjv@osCre@ocCzq@gtBmq@cjBw_@{bAlwAolExbF_iKhsNivD~gDyvArxCqS~iAc_Cqj@iqCaq@ifA_aAixAbbDceCsfBesApFqaL`tKcmLlfI{zLtcHwpEhyB_b@z_EsqFn{EokHjlRmpGv_RczFdqYwnFdtQyRd|I}vAz_HywJjfFweGbpJekC~Yo}AbaFilEpcHcmDzdNeh@hzDcjCn`Cq_BvpQ}s@hnEdiA|pFsa@pgHhCpaBn~uDkmAzqFs{CzcEk`DnrKcwGtgd@ykInz[y~@duL|{@pfJhqApvH{_@f{GdDpeHu`CxoH{}@x_EczCz|CooCjfFm{HxpYawEj{QiyEjhCuxCz{F}}Id{JavJpqEmtCzlFm_DrtB_jJbmHynHc]eaFd`Bc_DnrEuaDlqA}lI|uJcjBzvE}iAlfJgu@vbO}}ChsNoiBz`EkxBr{@ofDdtEatAlmLclBj{JqyBn`GdM|pEwnClcHacFjgDa{FrwEm{D~tGs{BlgMvc@r~CygDv`DuwGx}Gs}EpjAscD`cHcfDt`EwnArhEcg@rjBgaBfe@wcBrpCs`@dwCpZfaE`fBbbFso@lmCepC|_ByqClnBuqBi@ufDrUwwCeyBakHtxIk{C|~@_tB~_EqmF|yKu_CbzD}hCfjAowCxcBgfCowBcjH_Q}pHf|DotDkJqfD|bBuwH`uB{nFxv@{dC}TmmEpbBw`Ibj@g~BdnAeqCbZcpFb}EklGl{A}qCxnBkwEdjAqoCbbEu}Crm@gpL|lDgrIltGqxHjuH}uE~rJebB|jF{aDt`DqkAlkByo@tiFyk@v`GXviCugAr_@geFni@}lCfaEsaDhtIgbAbqEgjCj}BcnJptQgtChnFulAvsIujClhDmpApgE_bExxGidBbuLohFrdHysA|tEo\\v`Hu{GblReaDbdDckBb|E{~AzzFczBfgDuiFzeNs}Svnm@crPb_m@wpNrbj@gaOl|o@o\\teFugClmEywBpaC{p@rrErr@|oFpFbnHv{@~sIw|CfbM}gIl__@ccDt~JcjEjjCysBpbCucEk]axLhYmzR}]u_IeZqiB{_Ae}C`f@sxFlw@g}E{XgpBrjAavGwrBikFwx@e_E|uAyqF``@{gJyoC}rGc}E{bEe|@kzDjVoxDvOwp@~}A}`@hlKghA~yTcb@nsWyoDxs_@qtCnwWecEngSixGhdVmpAhtLy`CtvHk{CdaJwnBpxNevD`g\\wwC`G";

// Nota: ho aggiunto il replace per i backslash come precauzione vista la stringa precedente
const cleanPolyline = polyline.replace(/\\/g, '\\\\');

try {
  const points = decode(cleanPolyline, 5); 
  console.log("Decodifica riuscita!");
  console.log("Numero di punti totali:", points.length);
  // Stampiamo i primi due punti per vedere se sono validi
  console.log("Primo punto:", points[0]);
  console.log("Secondo punto:", points[1]);
} catch (e) {
  console.error("Errore durante la decodifica:", e);
}