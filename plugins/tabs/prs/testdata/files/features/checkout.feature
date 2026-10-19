Feature: Checkout

  Scenario: Total with tax
    Given a cart with 2 books at 10.00
    When I check out
    Then the total is 24.80 including tax

  Scenario: Members get 10% off
    Given a member with a cart with 2 books at 10.00
    When I check out
    Then the total is 22.32 including tax

  Scenario: Empty cart
    Given an empty cart
    When I check out
    Then the total is 0.00 including tax
