-- Product links and images on wishes and gifts.

alter table public.gifts
  add column url text check (url is null or url ~* '^https?://'),
  add column image_url text check (image_url is null or image_url ~* '^https?://');

alter table public.wishlist_items
  add column url text check (url is null or url ~* '^https?://'),
  add column image_url text check (image_url is null or image_url ~* '^https?://');
