from decimal import Decimal


def best_discount(cart, customer):
    """The biggest discount the customer can get on this cart."""
    offers = [Decimal(0)]
    if customer.is_member:
        offers.append(cart.subtotal * Decimal("0.10"))
    if len(cart.items) >= 5:
        offers.append(Decimal("5.00"))
    return max(offers)

