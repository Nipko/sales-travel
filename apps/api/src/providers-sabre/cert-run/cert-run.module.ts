import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ProviderCredentialsService } from '../../provider-credentials/provider-credentials.service.js';
import { SabreProviderFactory } from '../sabre.factory.js';

/**
 * Lo único que levanta el arnés de certificación: la base, la bóveda de credenciales y el factory de
 * Sabre. Los dos servicios se declaran sueltos y no por sus módulos: `ProviderCredentialsModule`
 * trae su controlador, y con él la auditoría y la red, que un proceso sin HTTP no usa. Sin colas, sin
 * correo y sin `OrdersModule`: el arnés no crea órdenes, no retiene carteras y no avisa a nadie.
 */
@Module({
  imports: [DatabaseModule],
  providers: [ProviderCredentialsService, SabreProviderFactory],
})
export class CertRunModule {}
