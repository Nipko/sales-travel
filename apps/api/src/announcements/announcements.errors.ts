import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Los errores de los anuncios de la plataforma (0079). La puerta (sólo el superadmin) es la de
 * network/: SuperadminGuard y SuperadminRequiredError.
 */

/** El anuncio no existe. 404. */
export class AnnouncementNotFoundError extends NotFoundException {
  readonly reason = 'ANNOUNCEMENT_NOT_FOUND';

  constructor() {
    super('Ese anuncio no existe. Recarga la lista.');
    this.name = 'AnnouncementNotFoundError';
  }
}

/** El nodo al que se dirige el anuncio no existe. 404. */
export class AnnouncementAudienceNotFoundError extends NotFoundException {
  readonly reason = 'ANNOUNCEMENT_AUDIENCE_NOT_FOUND';

  constructor() {
    super('Ese nodo no existe: elige otro o publica para toda la red.');
    this.name = 'AnnouncementAudienceNotFoundError';
  }
}

/** Un anuncio archivado ya no se corrige ni se vuelve a archivar. 409. */
export class AnnouncementArchivedError extends ConflictException {
  readonly reason = 'ANNOUNCEMENT_ARCHIVED';

  constructor() {
    super('Ese anuncio ya está archivado: publica uno nuevo.');
    this.name = 'AnnouncementArchivedError';
  }
}

/** La vigencia no es un período de hasta 31 días, o ya terminó. 400. */
export class AnnouncementWindowError extends BadRequestException {
  readonly reason = 'ANNOUNCEMENT_WINDOW_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'AnnouncementWindowError';
  }
}
