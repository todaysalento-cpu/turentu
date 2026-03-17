'use client';
import { FaUserPlus } from 'react-icons/fa';
import { Tariffa } from './TariffeForm';

type Props = {
  veicoloModello: string;
  targa?: string;
  tariffe: Tariffa[];
  distanzaSimulata?: number;
  origineSimulata?: string;
  destinazioneSimulata?: string;
  onConfigure: () => void;
  onSimula?: () => void;
};

const tipoColors: Record<Tariffa['tipo'], string> = {
  standard: 'bg-blue-200 text-blue-800',
  notturna: 'bg-purple-200 text-purple-800',
  festivo: 'bg-orange-200 text-orange-800',
};

export default function TariffeCardList({
  veicoloModello,
  targa,
  tariffe,
  distanzaSimulata,
  origineSimulata,
  destinazioneSimulata,
  onConfigure,
  onSimula,
}: Props) {
  const hasTariffa = tariffe.length > 0;
  const highlightColor = 'bg-green-50 text-green-800';
  const hasSimulazione = origineSimulata && destinazioneSimulata;

  return (
    <div className="rounded-lg p-2 bg-white shadow-sm flex flex-col gap-1 relative">
      {/* Header */}
      <div className="flex flex-col mb-1">
        <div className="flex justify-between items-center pb-1">
          <div className="flex items-baseline gap-1">
            <h3 className="font-semibold text-sm">{veicoloModello}</h3>
            {targa && <span className="text-[8px] text-gray-500 font-medium">{targa}</span>}
          </div>
          <button
            onClick={onConfigure}
            className="px-1.5 py-0.5 text-[9px] rounded-md bg-black text-white hover:bg-gray-800 transition"
          >
            {hasTariffa ? 'Modifica' : 'Configura'}
          </button>
        </div>

        {/* Separatore delicato sotto header */}
        <div className="border-b border-gray-200 mb-1"></div>

        {/* Sezione simulazione o invito ad aggiungere tariffe */}
        {hasTariffa ? (
          <div className="mt-1 text-[9px] flex flex-col gap-1">
            {hasSimulazione ? (
              <div className="flex items-center gap-1">
                <span className={`px-1.5 py-0.5 rounded ${highlightColor}`}>
                  {origineSimulata} → {destinazioneSimulata}
                  {distanzaSimulata !== undefined && (
                    <span className="ml-1 text-[8px]">- {distanzaSimulata.toFixed(2)} km</span>
                  )}
                </span>
                {onSimula && (
                  <button
                    onClick={onSimula}
                    className="px-1.5 py-0.5 text-[8px] font-semibold rounded-full bg-yellow-400 text-white hover:bg-yellow-500 transition"
                  >
                    Nuova simulazione
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <span className="italic text-gray-700 text-[9px]">Inserisci corsa per stimare guadagno</span>
                {onSimula && (
                  <button
                    onClick={onSimula}
                    className="px-2 py-0.5 text-[9px] font-semibold rounded-full bg-yellow-400 text-white hover:bg-yellow-500 transition"
                  >
                    Simula ora
                  </button>
                )}
              </div>
            )}
            {/* Separatore delicato sotto simulazione */}
            <div className="border-b border-gray-100 w-full"></div>
          </div>
        ) : (
          <div className="italic text-gray-600 text-[9px] mt-1 mb-1">
            Nessuna tariffa configurata – clicca su <span className="font-semibold">Configura</span> per aggiungerle
          </div>
        )}
      </div>

      {/* Tariffe */}
      {hasTariffa && (
        <div className="flex flex-col gap-1 text-xs">
          {/* Header tariffe */}
          <div className="flex gap-1 font-medium text-gray-600 items-center text-[9px]">
            <div className="min-w-[60px]"></div>
            <div className="min-w-[50px] text-center text-black">€/km</div>
            <div className="min-w-[50px] text-center">
              <FaUserPlus className="inline text-[9px] mr-1 text-black" />
            </div>
            <div className="min-w-[70px] flex justify-center">
              <span className={`bg-green-100 text-green-800 text-[8px] px-1 rounded-full font-semibold`}>
                Stimato
              </span>
            </div>
          </div>

          {tariffe.map(t => {
            const prezzoStimato = distanzaSimulata !== undefined ? t.euro_km * distanzaSimulata : null;

            return (
              <div key={t.tipo} className="flex gap-1 items-center">
                <div className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${tipoColors[t.tipo]} text-center min-w-[60px]`}>
                  {t.tipo}
                </div>
                <div className="px-1 py-0.5 rounded bg-gray-50 text-[9px] text-center min-w-[50px] flex-shrink-0 text-black">
                  € {t.euro_km.toFixed(2)}
                </div>
                <div className="px-1 py-0.5 rounded bg-gray-50 text-[9px] text-center min-w-[50px] flex-shrink-0 text-black">
                  € {t.prezzo_passeggero.toFixed(2)}
                </div>
                <div className={`px-1 py-0.5 rounded text-[9px] text-center min-w-[70px] flex-shrink-0 ${highlightColor}`}>
                  {prezzoStimato !== null ? `€ ${prezzoStimato.toFixed(2)}` : '–'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}