import { Money } from '@sales-travel/canonical';
import type { ConfirmCarRequest } from '../types.js';

type FormBody = Record<string, string | number | null | undefined>;

export function buildConfirmationBody(req: ConfirmCarRequest): FormBody {
  const body: FormBody = {
    uniqid: req.uniqid,
    paymentType: req.paymentType,
    rateType: req.rateType,
    companyCode: req.companyCode,
    sippCode: req.sippCode,
    pickUpLocation: req.pickUpLocation,
    dropOffLocation: req.dropOffLocation,
    pickUpDate: req.pickUpDate,
    dropOffDate: req.dropOffDate,
    pickUpHour: req.pickUpHour,
    dropOffHour: req.dropOffHour,
    pickUpAddress: req.pickUpAddress || 'NA',
    dropOffAddress: req.dropOffAddress || 'NA',
    firstName: req.firstName,
    lastName: req.lastName,
    age: req.age,
    email: req.email,
    realBase: Money.toMajor(req.realBase).toFixed(2),
    realTax: Money.toMajor(req.realTax).toFixed(2),
    total: Money.toMajor(req.total).toFixed(2),
    currency: req.total.currency,
  };

  if (req.ccrc) body['ccrc'] = req.ccrc;
  if (req.cdCode) body['cdCode'] = req.cdCode;
  if (req.pcCode) body['pcCode'] = req.pcCode;
  if (req.flightNumber) body['flight_number'] = req.flightNumber;
  if (req.membershipNumber) body['fmember'] = req.membershipNumber;
  if (req.frequentFlyer) {
    body['fFlyerNbr'] = req.frequentFlyer.number;
    body['fFlyerCarrier'] = req.frequentFlyer.carrier;
  }
  if (req.onHold) body['on_hold'] = '1';
  if (req.language) body['language'] = req.language;

  if (req.extras) {
    if (req.extras.childBoosterSeat) body['cbs'] = '1';
    if (req.extras.childToddlerSeat) body['cst'] = '1';
    if (req.extras.gps) body['gps'] = '1';
    if (req.extras.skyracks) body['skyracks'] = '1';
  }

  return body;
}
