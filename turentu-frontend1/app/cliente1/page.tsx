export default function ClientePage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">Dashboard Cliente</h1>
      <p>Visualizza le tue prenotazioni e lo stato delle corse.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="p-4 bg-white dark:bg-zinc-800 rounded shadow">
          <h2 className="font-semibold">Prenotazione 1</h2>
          <p>Veicolo: Corsia 1</p>
          <p>Stato: Confermata</p>
        </div>
        <div className="p-4 bg-white dark:bg-zinc-800 rounded shadow">
          <h2 className="font-semibold">Prenotazione 2</h2>
          <p>Veicolo: Corsia 2</p>
          <p>Stato: In attesa</p>
        </div>
      </div>
    </div>
  );
}
