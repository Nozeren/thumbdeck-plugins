from decimal import Decimal
from .discounts import best_discount

TAX_RATE = Decimal("0.24")


def total(cart, customer=None):
    """Sum of the cart after the best discount, with tax."""
    subtotal = sum(item.price * item.quantity for item in cart.items)
    discount = best_discount(cart, customer) if customer else Decimal(0)
    return (subtotal - discount) * (1 + TAX_RATE)


def is_empty(cart):
    return not cart.items


def item_count(cart):
    return sum(item.quantity for item in cart.items)


def receipt(cart, customer=None):
    """The lines of a printed receipt."""
    lines = [f"{item.name:<20} {item.price * item.quantity:>8}" for item in cart.items]
    lines.append(f"{'Total':<20} {total(cart, customer):>8}")
    return "\n".join(lines)
