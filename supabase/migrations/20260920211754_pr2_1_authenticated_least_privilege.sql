-- PR2.1: remove default/pre-existing table privileges not needed by the client.
-- RLS policies remain the data-access boundary; authenticated only needs CRUD.
begin;

revoke all on
  public.profiles,
  public.invoices,
  public.tax_payments,
  public.tax_settings
from authenticated;

grant select, insert, update, delete on
  public.profiles,
  public.invoices,
  public.tax_payments,
  public.tax_settings
to authenticated;

commit;
