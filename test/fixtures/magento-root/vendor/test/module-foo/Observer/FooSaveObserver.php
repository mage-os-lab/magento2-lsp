<?php

namespace Test\Foo\Observer;

use Magento\Framework\Event\ObserverInterface;
use Magento\Framework\Event\Observer;

class FooSaveObserver implements ObserverInterface
{
    public function execute(Observer $observer): void {}
}
