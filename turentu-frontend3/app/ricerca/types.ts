export interface Coord { lat: number; lon: number; }

export interface LocationValue {
  nome: string;
  coord: Coord;
}

export interface RicercaForm {
  localitaOrigine: LocationValue | null;
  localitaDestinazione: LocationValue | null;
  start_datetime: string;
  posti_richiesti: number;
}

export interface Risultato {
  id: string;
  oraPartenza: string;
  oraArrivo: string;
  localitaOrigine: string;
  localitaDestinazione: string;
  durataMs?: number;
  prezzo?: number;
  modello: string;
  servizi?: string[];
  stato?: string[];
}

export type FiltroSlot = "Tutte" | "Liberi" | "Prenotabili";
