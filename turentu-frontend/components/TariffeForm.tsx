'use client';
import { useState } from 'react';
import TariffeModal from './TariffeModal';

export type Tariffa = {
  id?: number;
  veicolo_id: number;
  tipo: 'standard' | 'notturna' | 'festivo';
  euro_km: number;
  prezzo_passeggero: number;
  giorno_settimana?: string | null;
  ora_inizio?: string | null;
  ora_fine?: string | null;
};

type TariffeFormProps = {
  veicoloId: number;
  veicoloModello: string;
  tariffeIniziali: Tariffa[];
  loading?: boolean;
  onSaveAll: (tariffe: Tariffa[]) => void;
};

export default function TariffeForm({
  veicoloId,
  veicoloModello,
  tariffeIniziali,
  loading = false,
  onSaveAll,
}: TariffeFormProps) {
  const [modalOpen, setModalOpen] = useState(true); // Apri modal subito
  return (
    <TariffeModal
      open={modalOpen}
      veicoloId={veicoloId}
      veicoloModello={veicoloModello}
      tariffeIniziali={tariffeIniziali}
      loading={loading}
      onClose={() => setModalOpen(false)}
      onSaveAll={onSaveAll}
    />
  );
}