import { Module } from '@nestjs/common';
import { GovernancePaymentsService } from '../governance/governance-payments.service.js';
import { GovernanceStore } from '../governance/governance.store.js';
import { KillSwitchStore } from './kill-switch.store.js';
import { ProviderEnablementStore } from './provider-enablement.store.js';

/**
 * El almacén de la habilitación de proveedores, con su caché, y el de los apagados de emergencia
 * del panel (0077). Lo importan los módulos de los registries (vuelos y hoteles), el del circuit
 * breaker (`SearchModule`) y el panel de la plataforma, y cada uno tiene que ser UNA instancia:
 * escribir desde el panel invalida la caché que leen las búsquedas y actualiza la copia de los
 * apagados que aplica el breaker. No importa nada (base, auditoría y trabajo en vuelo son globales),
 * así que nadie que lo importe arma un ciclo.
 */
@Module({
  // GovernanceStore vive aquí por la misma razón: UNA instancia, que invalidan las escrituras del
  // panel de proveedores y del de gobierno (db/migrations/0089).
  providers: [ProviderEnablementStore, KillSwitchStore, GovernanceStore, GovernancePaymentsService],
  exports: [ProviderEnablementStore, KillSwitchStore, GovernanceStore, GovernancePaymentsService],
})
export class ProviderEnablementModule {}
