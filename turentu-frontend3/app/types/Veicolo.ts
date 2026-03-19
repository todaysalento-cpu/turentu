// app/types/veicolo.ts

export type Veicolo = {
  id?: number;
  marca?: string;
  modello: string;
  tipo?: string;
  anno?: number;
  posti_totali: number;
  targa?: string;
  servizi: string[];
  lat?: number;
  lon?: number;
  localita?: string;
  image_url?: string;
};